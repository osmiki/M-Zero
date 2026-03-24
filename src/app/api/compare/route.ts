import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPersonalAccessToken, extractFigmaTokensFromNode, fetchFigmaFramePng, normalizeNodeId, parseFigmaDevModeUrl } from "@/lib/figma";
import { compareTokenToComputed, type CompareConfig, type CompareRow } from "@/lib/compare";
import { getWebData } from "@/lib/webDataStore";
import { cookies } from "next/headers";
import { getSession, getSessionCookieName } from "@/lib/sessionStore";
import { runVisualCompare, type VisualCompareResult } from "@/lib/visualCompare";

export const runtime = "nodejs";

const BodySchema = z.object({
  webDataId: z.string().min(1),
  figma: z.object({
    devModeUrlOrFileKey: z.string().min(1),
    nodeId: z.string().optional(),
    personalAccessToken: z.string().optional(),
  }),
  thresholdPx: z.number().min(0).max(50).default(2),
  // 노드-클래스 매핑: { "Figma 노드명": "css-class" }
  nodeClassMapping: z.record(z.string(), z.string()).optional(),
});

type RunResult = {
  className: string;
  selector: string;
  matchedWebClassName?: string | null;
  severity: "pass" | "fail";
  /** strict = COMPONENT/INSTANCE, foundational = FRAME/GROUP 등 일반 레이어 */
  compareMode: "strict" | "foundational";
  diffs: Array<{
    key: string;
    figma?: string | number | null;
    web?: string | number | null;
    delta?: number | null;
  }>;
  rows: CompareRow[];
  bbox?: { x: number; y: number; width: number; height: number } | null;
  textBbox?: { x: number; y: number; width: number; height: number } | null;
  fixedPosition?: "top" | "bottom" | null;
  elementFound: boolean;
};

function canonicalClassKey(input: string) {
  // case-insensitive, remove spaces and special chars like '-', '_', etc.
  return String(input)
    .toLowerCase()
    .replace(/[\s\W_]+/g, "");
}

function findBestWebEntry(
  webElements: Record<string, { bbox: any; classList: string[]; computed: Record<string, string>; textBbox?: any }>,
  webByCanonical: Map<string, { bbox: any; classList: string[]; computed: Record<string, string>; textBbox?: any }>,
  figmaClassName: string
): { entry: (typeof webElements)[string] | null; matchedWebClassName: string | null } {
  const direct = webElements[figmaClassName];
  if (direct) return { entry: direct, matchedWebClassName: figmaClassName };

  const key = canonicalClassKey(figmaClassName);
  const exact = key ? webByCanonical.get(key) : null;
  if (exact) {
    // Try to pick a representative class name for debugging
    const matchedName = Object.keys(webElements).find((k) => canonicalClassKey(k) === key) ?? null;
    return { entry: exact, matchedWebClassName: matchedName };
  }

  // Fuzzy: containment match on canonical keys.
  // 길이 유사도 < 0.6이면 제외 — "group1000006401" vs "group" (0.36) 같은 오매칭 방지
  if (!key) return { entry: null, matchedWebClassName: null };

  let best: { score: number; webKey: string; entry: (typeof webElements)[string] } | null = null;
  for (const [webKey, entry] of Object.entries(webElements)) {
    const wk = canonicalClassKey(webKey);
    if (!wk) continue;
    const contains = wk.includes(key) || key.includes(wk);
    if (!contains) continue;
    // 길이 유사도 필터: 짧은 쪽 / 긴 쪽 >= 0.6 이어야 매칭 허용
    const ratio = Math.min(key.length, wk.length) / Math.max(key.length, wk.length);
    if (ratio < 0.6) continue;
    // Score: smaller length delta is better; prefer web key that contains fig key.
    const lenDelta = Math.abs(wk.length - key.length);
    const bias = wk.includes(key) ? 0 : 2; // prefer wk contains key
    const score = lenDelta + bias;
    if (!best || score < best.score) best = { score, webKey, entry };
  }

  if (best) return { entry: best.entry, matchedWebClassName: best.webKey };
  return { entry: null, matchedWebClassName: null };
}

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const web = getWebData(body.webDataId);
    if (!web) {
      return NextResponse.json({ ok: false, error: "webDataId를 찾지 못했습니다. 스크립트를 다시 실행해주세요." }, { status: 404 });
    }

    const figmaParsed = parseFigmaDevModeUrl(body.figma.devModeUrlOrFileKey);
    const fileKey = figmaParsed.fileKey ?? body.figma.devModeUrlOrFileKey.trim();
    const nodeId = normalizeNodeId(body.figma.nodeId ?? figmaParsed.nodeId ?? "");
    if (!nodeId) {
      return NextResponse.json(
        { ok: false, error: "Figma Dev Mode URL에 node-id가 포함되어야 합니다. (예: ?node-id=0-2789)" },
        { status: 400 }
      );
    }

    const c = await cookies();
    const sid = c.get(getSessionCookieName())?.value ?? null;
    const sess = getSession(sid);
    const oauthToken = sess?.figma?.accessToken;

    const token = body.figma.personalAccessToken ?? oauthToken ?? process.env.FIGMA_TOKEN;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Figma Personal Access Token이 없습니다. 입력하거나 서버 환경변수 FIGMA_TOKEN을 설정해주세요." },
        { status: 400 }
      );
    }

    await assertPersonalAccessToken(token);

    const { tokens } = await extractFigmaTokensFromNode({
      personalAccessToken: token,
      fileKey,
      nodeId,
      maxTokens: 600,
    });

    // compareMode는 토큰별로 결정 (compareConfig는 thresholdPx만 공유)
    const baseThreshold = body.thresholdPx;

    // IoU 매칭용 unique 웹 요소 목록 (bbox 기반 중복 제거)
    const uniqueWebElems = buildUniqueWebElements(web.elements);

    // Figma 루트 프레임 bbox (tokens[0]이 root)
    const rootFigmaBbox = tokens[0]?.figmaBbox ?? null;
    // 스케일: Figma 프레임 너비 → 웹 뷰포트 너비
    const figmaToWebScale = rootFigmaBbox && rootFigmaBbox.width > 0
      ? web.viewport.width / rootFigmaBbox.width
      : 1;
    const rootFigmaX = rootFigmaBbox?.x ?? 0;
    const rootFigmaY = rootFigmaBbox?.y ?? 0;

    const IOU_THRESHOLD = 0.25; // 이 이상이면 위치 매칭 성공으로 판정

    // Build a relaxed lookup index for web elements.
    const webByCanonical = new Map<string, (typeof web)["elements"][string]>();
    for (const [cls, entry] of Object.entries(web.elements)) {
      const key = canonicalClassKey(cls);
      if (!key) continue;
      if (!webByCanonical.has(key)) webByCanonical.set(key, entry);
    }

    const mapping = body.nodeClassMapping ?? {};

    const STRICT_NODE_TYPES = new Set(["COMPONENT", "INSTANCE", "COMPONENT_SET"]);

    const results: RunResult[] = [];
    for (const t of tokens) {
      const className = t.className;
      // COMPONENT/INSTANCE 자체이거나 그 계층 안에 있는 노드 → strict (모든 속성 비교)
      // 그 외 일반 FRAME/GROUP → foundational (Foundation 값만 비교)
      const compareMode: "strict" | "foundational" =
        STRICT_NODE_TYPES.has(t.nodeType) || t.insideComponent ? "strict" : "foundational";
      const compareConfig: CompareConfig = { thresholdPx: baseThreshold, compareMode };

      // 매핑 테이블 우선 적용: 매핑된 노드는 지정 CSS 클래스로 직접 비교
      const mappedClass = mapping[className];
      if (mappedClass) {
        const selector = `.${cssEscape(mappedClass)}`;
        const entry = web.elements[mappedClass];
        if (!entry) {
          const out = compareTokenToComputed(t, null, compareConfig);
          results.push({ className, selector, matchedWebClassName: null, severity: "fail", compareMode, diffs: out.diffs, rows: out.rows, bbox: null, textBbox: null, fixedPosition: null, elementFound: false });
        } else {
          const out = compareTokenToComputed(t, { classList: entry.classList, computed: entry.computed }, compareConfig);
          const fp = entry.computed?.['_fixedPosition'];
          results.push({ className, selector, matchedWebClassName: mappedClass, severity: out.severity, compareMode, diffs: out.diffs, rows: out.rows, bbox: entry.bbox ?? null, textBbox: entry.textBbox ?? null, fixedPosition: (fp === "top" || fp === "bottom") ? fp : null, elementFound: true });
        }
        continue;
      }

      // IoU 위치 기반 매칭 시도
      const selector = `.${cssEscape(className)}`;
      let iouEntry: typeof uniqueWebElems[number] | null = null;
      if (t.figmaBbox) {
        const scaledFigmaBbox: BboxRect = {
          x: (t.figmaBbox.x - rootFigmaX) * figmaToWebScale,
          y: (t.figmaBbox.y - rootFigmaY) * figmaToWebScale,
          width: t.figmaBbox.width * figmaToWebScale,
          height: t.figmaBbox.height * figmaToWebScale,
        };
        let bestIou = IOU_THRESHOLD;
        for (const candidate of uniqueWebElems) {
          const score = bboxIou(scaledFigmaBbox, candidate.bbox);
          if (score > bestIou) { bestIou = score; iouEntry = candidate; }
        }
      }

      if (iouEntry) {
        const out = compareTokenToComputed(t, { classList: iouEntry.classList, computed: iouEntry.computed }, compareConfig);
        const iouFp = iouEntry.computed?.['_fixedPosition'];
        results.push({
          className,
          selector: `.${cssEscape(iouEntry.representativeClass)}`,
          matchedWebClassName: iouEntry.representativeClass,
          severity: out.severity,
          compareMode,
          diffs: out.diffs,
          rows: out.rows,
          bbox: iouEntry.bbox,
          textBbox: iouEntry.textBbox ?? null,
          fixedPosition: (iouFp === "top" || iouFp === "bottom") ? iouFp : null,
          elementFound: true,
        });
        continue;
      }

      // IoU 실패 → 이름 기반 폴백
      const found = findBestWebEntry(web.elements, webByCanonical, className);
      const entry = found.entry;
      if (!entry) {
        const out = compareTokenToComputed(t, null, compareConfig);
        results.push({ className, selector, matchedWebClassName: null, severity: "fail", compareMode, diffs: out.diffs, rows: out.rows, bbox: null, textBbox: null, fixedPosition: null, elementFound: false });
        continue;
      }
      const out = compareTokenToComputed(t, { classList: entry.classList, computed: entry.computed }, compareConfig);
      const entryFp = entry.computed?.['_fixedPosition'];
      results.push({
        className, selector,
        matchedWebClassName: found.matchedWebClassName,
        severity: out.severity,
        compareMode,
        diffs: out.diffs,
        rows: out.rows,
        bbox: entry.bbox ?? null,
        textBbox: entry.textBbox ?? null,
        fixedPosition: (entryFp === "top" || entryFp === "bottom") ? entryFp : null,
        elementFound: true,
      });
    }

    const summary = summarize(results);

    // Visual QA: Claude Vision comparison
    let visualQa: VisualCompareResult | null = null;
    try {
      const webBase64 = web.screenshotDataUrl?.replace(/^data:[^,]+,/, "") ?? null;
      if (webBase64) {
        const figmaBase64 = await fetchFigmaFramePng({ personalAccessToken: token, fileKey, nodeId, scale: 1 });
        visualQa = figmaBase64
          ? await runVisualCompare({ figmaBase64, webBase64 })
          : { ok: false, reason: "Figma 프레임 이미지를 가져올 수 없습니다" };
      } else {
        visualQa = { ok: false, reason: "웹 스크린샷 없음 — 확장프로그램을 다시 실행해주세요" };
      }
    } catch (e) {
      visualQa = { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }

    return NextResponse.json({
      ok: true,
      summary,
      results,
      visualQa,
      meta: {
        web: { href: web.href, extractedAt: web.extractedAt, viewport: web.viewport, scrollHeight: web.scrollHeight, scrollY: web.scrollY, webDataId: body.webDataId },
        figma: { fileKey, nodeId },
        thresholdPx: body.thresholdPx,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}

function summarize(results: RunResult[]) {
  let pass = 0, warn = 0, fail = 0, missing = 0;
  let strictFail = 0, foundationalFail = 0;
  for (const r of results) {
    if (!r.elementFound) missing++;
    if (r.severity === "pass") pass++;
    else {
      fail++;
      if (r.compareMode === "strict") strictFail++;
      else foundationalFail++;
    }
  }
  return { total: results.length, pass, warn, fail, missing, strictFail, foundationalFail };
}

type BboxRect = { x: number; y: number; width: number; height: number };

function bboxIou(a: BboxRect, b: BboxRect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const aArea = a.width * a.height;
  const bArea = b.width * b.height;
  const union = aArea + bArea - inter;
  return union <= 0 ? 0 : inter / union;
}

function buildUniqueWebElements(elements: Record<string, { bbox: { x: number; y: number; width: number; height: number } | null; classList: string[]; computed: Record<string, string>; textBbox?: { x: number; y: number; width: number; height: number } | null }>) {
  // 같은 bbox를 가진 요소들을 그룹화: computed styles 병합으로 padding/color 누락 방지
  const groups = new Map<string, {
    bbox: BboxRect;
    classList: string[];
    computeds: Record<string, string>[];
    representativeClass: string;
    textBbox: BboxRect | null;
  }>();

  for (const [cls, entry] of Object.entries(elements)) {
    if (!entry.bbox || entry.bbox.width <= 0 || entry.bbox.height <= 0) continue;
    const key = `${Math.round(entry.bbox.x)},${Math.round(entry.bbox.y)},${Math.round(entry.bbox.width)},${Math.round(entry.bbox.height)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        bbox: entry.bbox as BboxRect,
        classList: [...entry.classList],
        computeds: [entry.computed],
        representativeClass: cls,
        textBbox: (entry.textBbox as BboxRect | null) ?? null,
      });
    } else {
      const g = groups.get(key)!;
      for (const c of entry.classList) {
        if (!g.classList.includes(c)) g.classList.push(c);
      }
      g.computeds.push(entry.computed);
    }
  }

  return Array.from(groups.values()).map(g => ({
    bbox: g.bbox,
    classList: g.classList,
    computed: mergeComputedStyles(g.computeds),
    representativeClass: g.representativeClass,
    textBbox: g.textBbox,
  }));
}

// 같은 bbox 요소들의 computed styles 병합: 0/transparent가 아닌 값 우선
const ZERO_LIKE = new Set(['0', '0px', '0%', '', 'normal', 'rgba(0, 0, 0, 0)', 'transparent']);
function mergeComputedStyles(computeds: Record<string, string>[]): Record<string, string> {
  if (computeds.length === 1) return computeds[0];
  const merged = { ...computeds[0] };
  for (let i = 1; i < computeds.length; i++) {
    for (const [k, v] of Object.entries(computeds[i])) {
      if (!merged[k] || ZERO_LIKE.has(merged[k].trim())) {
        if (v && !ZERO_LIKE.has(v.trim())) merged[k] = v;
      }
    }
  }
  return merged;
}

function cssEscape(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

