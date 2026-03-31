import { NextResponse } from "next/server";
import { z } from "zod";
import { assertPersonalAccessToken, extractFigmaTokensFromNode, normalizeNodeId, parseFigmaDevModeUrl } from "@/lib/figma";
import { compareTokenToComputed, type CompareConfig, type CompareRow } from "@/lib/compare";
import { getWebDataAsync } from "@/lib/webDataStore";
import { cookies } from "next/headers";
import { getSession, getSessionCookieName } from "@/lib/sessionStore";

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

type MatchMethod = "mapping" | "name-exact" | "name-normalized" | "iou" | "text" | null;

type RunResult = {
  className: string;
  selector: string;
  matchedWebClassName?: string | null;
  severity: "pass" | "warn" | "fail";
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
  matchMethod: MatchMethod;
  matchScore: number | null;
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
  webByCanonicalWithName: Map<string, { entry: { bbox: any; classList: string[]; computed: Record<string, string>; textBbox?: any }; originalName: string }>,
  figmaClassName: string
): { entry: (typeof webElements)[string] | null; matchedWebClassName: string | null; isExact: boolean } {
  const direct = webElements[figmaClassName];
  if (direct) return { entry: direct, matchedWebClassName: figmaClassName, isExact: true };

  const key = canonicalClassKey(figmaClassName);
  const canonical = key ? webByCanonicalWithName.get(key) : null;
  if (canonical) {
    return { entry: canonical.entry, matchedWebClassName: canonical.originalName, isExact: false };
  }

  return { entry: null, matchedWebClassName: null, isExact: false };
}

export async function POST(req: Request) {
  try {
    const body = BodySchema.parse(await req.json());
    const web = await getWebDataAsync(body.webDataId);
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

    const token = process.env.FIGMA_TOKEN ?? oauthToken ?? body.figma.personalAccessToken;
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
      maxTokens: 1500,
    });

    // compareMode는 토큰별로 결정 (compareConfig는 thresholdPx만 공유)
    const baseThreshold = body.thresholdPx;

    // IoU 매칭용 unique 웹 요소 목록 (bbox 기반 중복 제거)
    const uniqueWebElems = buildUniqueWebElements(web.elements);

    // 정규화 이름 매칭용 맵: canonicalKey → { entry, originalName }
    // Product-List-Grid → productlistgrid → product-list-grid 등과 매칭
    const webByCanonical = new Map<string, { entry: (typeof web.elements)[string]; originalName: string }>();
    for (const [cls, entry] of Object.entries(web.elements)) {
      const key = canonicalClassKey(cls);
      if (key && !webByCanonical.has(key)) webByCanonical.set(key, { entry, originalName: cls });
    }

    // Figma 루트 프레임 bbox (tokens[0]이 root)
    const rootFigmaBbox = tokens[0]?.figmaBbox ?? null;
    // 스케일: Figma 프레임 너비 → 웹 뷰포트 너비
    const figmaToWebScale = rootFigmaBbox && rootFigmaBbox.width > 0
      ? web.viewport.width / rootFigmaBbox.width
      : 1;
    const rootFigmaX = rootFigmaBbox?.x ?? 0;
    const rootFigmaY = rootFigmaBbox?.y ?? 0;

    const IOU_THRESHOLD = 0.55;

    const STRICT_NODE_TYPES = new Set(["COMPONENT", "INSTANCE", "COMPONENT_SET"]);
    const usedWebIndices = new Set<number>();

    const results: RunResult[] = [];
    for (const t of tokens) {
      const className = t.className;

      // ── 자동 생성 이름 필터 ──
      if (isAutoGeneratedName(className) && !STRICT_NODE_TYPES.has(t.nodeType) && !t.insideComponent && !t.characters) {
        continue;
      }

      const compareMode: "strict" | "foundational" =
        STRICT_NODE_TYPES.has(t.nodeType) || t.insideComponent ? "strict" : "foundational";
      const compareConfig: CompareConfig = { thresholdPx: baseThreshold, compareMode };

      // ── 1순위: 이름 exact match ──
      const selector = `.${cssEscape(className)}`;
      const directEntry = web.elements[className];
      if (directEntry) {
        const out = compareTokenToComputed(t, { classList: directEntry.classList, computed: directEntry.computed }, compareConfig);
        const fp = directEntry.computed?.['_fixedPosition'];
        results.push({
          className, selector,
          matchedWebClassName: className,
          severity: out.severity, compareMode,
          matchMethod: "name-exact",
          matchScore: 1.0,
          diffs: out.diffs, rows: out.rows,
          bbox: directEntry.bbox ?? null,
          textBbox: directEntry.textBbox ?? null,
          fixedPosition: (fp === "top" || fp === "bottom") ? fp : null,
          elementFound: true,
        });
        continue;
      }

      // ── 2순위: 정규화 이름 매칭 (Product-List-Grid ↔ product-list-grid, product-list 등) ──
      // exact 정규화 → prefix 포함 순으로 시도 (최소 8자 이상만)
      const canonicalKey = canonicalClassKey(className);
      let normalizedEntry = canonicalKey ? webByCanonical.get(canonicalKey) : null;
      if (!normalizedEntry && canonicalKey && canonicalKey.length >= 8) {
        for (const [webKey, entry] of webByCanonical) {
          if (webKey.length < 6) continue;
          if (canonicalKey.startsWith(webKey) || webKey.startsWith(canonicalKey)) {
            normalizedEntry = entry;
            break;
          }
        }
      }
      if (normalizedEntry) {
        const out = compareTokenToComputed(t, { classList: normalizedEntry.entry.classList, computed: normalizedEntry.entry.computed }, compareConfig);
        const fp = normalizedEntry.entry.computed?.['_fixedPosition'];
        results.push({
          className, selector: `.${cssEscape(normalizedEntry.originalName)}`,
          matchedWebClassName: normalizedEntry.originalName,
          severity: out.severity, compareMode,
          matchMethod: "name-normalized",
          matchScore: 0.9,
          diffs: out.diffs, rows: out.rows,
          bbox: normalizedEntry.entry.bbox ?? null,
          textBbox: normalizedEntry.entry.textBbox ?? null,
          fixedPosition: (fp === "top" || fp === "bottom") ? fp : null,
          elementFound: true,
        });
        continue;
      }

      // ── 3순위: IoU 위치 매칭 ──
      let iouEntry: typeof uniqueWebElems[number] | null = null;
      let iouEntryIndex = -1;
      let bestIou = IOU_THRESHOLD;
      if (t.figmaBbox) {
        const scaledFigmaBbox: BboxRect = {
          x: (t.figmaBbox.x - rootFigmaX) * figmaToWebScale,
          y: (t.figmaBbox.y - rootFigmaY) * figmaToWebScale,
          width: t.figmaBbox.width * figmaToWebScale,
          height: t.figmaBbox.height * figmaToWebScale,
        };
        for (let ci = 0; ci < uniqueWebElems.length; ci++) {
          if (usedWebIndices.has(ci)) continue;
          const score = bboxIou(scaledFigmaBbox, uniqueWebElems[ci].bbox);
          if (score > bestIou) { bestIou = score; iouEntry = uniqueWebElems[ci]; iouEntryIndex = ci; }
        }
      }
      if (iouEntry && iouEntryIndex >= 0) {
        usedWebIndices.add(iouEntryIndex);
        const out = compareTokenToComputed(t, { classList: iouEntry.classList, computed: iouEntry.computed }, compareConfig);
        const iouFp = iouEntry.computed?.['_fixedPosition'];
        results.push({
          className,
          selector: `.${cssEscape(iouEntry.representativeClass)}`,
          matchedWebClassName: iouEntry.representativeClass,
          severity: out.severity, compareMode,
          matchMethod: "iou",
          matchScore: bestIou,
          diffs: out.diffs, rows: out.rows,
          bbox: iouEntry.bbox,
          textBbox: iouEntry.textBbox ?? null,
          fixedPosition: (iouFp === "top" || iouFp === "bottom") ? iouFp : null,
          elementFound: true,
        });
        continue;
      }

      // ── 매칭 실패 → Missing ──
      const out = compareTokenToComputed(t, null, compareConfig);
      results.push({ className, selector, matchedWebClassName: null, severity: "fail", compareMode, matchMethod: null, matchScore: null, diffs: out.diffs, rows: out.rows, bbox: null, textBbox: null, fixedPosition: null, elementFound: false });
    }

    const summary = summarize(results);

    return NextResponse.json({
      ok: true,
      summary,
      results,
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
  const matchMethods = { mapping: 0, nameExact: 0, nameNormalized: 0, iou: 0, text: 0, missing: 0 };
  for (const r of results) {
    if (!r.elementFound) { missing++; matchMethods.missing++; }
    else {
      if (r.matchMethod === "mapping") matchMethods.mapping++;
      else if (r.matchMethod === "name-exact") matchMethods.nameExact++;
      else if (r.matchMethod === "name-normalized") matchMethods.nameNormalized++;
      else if (r.matchMethod === "iou") matchMethods.iou++;
      else if (r.matchMethod === "text") matchMethods.text++;
    }
    if (r.severity === "pass") pass++;
    else if (r.severity === "warn") { warn++; pass++; }
    else {
      fail++;
      if (r.compareMode === "strict") strictFail++;
      else foundationalFail++;
    }
  }
  return { total: results.length, pass, warn, fail, missing, strictFail, foundationalFail, matchMethods };
}

type BboxRect = { x: number; y: number; width: number; height: number };

/**
 * X축 우선 IoU: X겹침 50% 이상 + 너비 유사도 ±40% 필수
 * Y축은 더미 데이터로 밀릴 수 있으므로 관대하게 처리.
 * 전체 너비 섹션(widthRatio ≥ 0.85)은 Y 위치 근접도만으로 매칭 허용.
 */
function bboxIou(a: BboxRect, b: BboxRect): number {
  // X축 겹침 계산
  const xOverlapStart = Math.max(a.x, b.x);
  const xOverlapEnd = Math.min(a.x + a.width, b.x + b.width);
  const xOverlap = Math.max(0, xOverlapEnd - xOverlapStart);
  const minWidth = Math.min(a.width, b.width);

  // X축 겹침이 작은 쪽 너비의 50% 미만이면 매칭 불가
  if (minWidth <= 0 || xOverlap / minWidth < 0.5) return 0;

  // 너비 유사도: ±40% 이내
  const widthRatio = Math.min(a.width, b.width) / Math.max(a.width, b.width);
  if (widthRatio < 0.6) return 0;

  // 높이 유사도: ±60% 이내 (Y 밀림 허용하되, 크기는 비슷해야 함)
  const heightRatio = Math.min(a.height, b.height) / Math.max(a.height, b.height);
  if (heightRatio < 0.4) return 0;

  // 기본 IoU 계산
  const y1 = Math.max(a.y, b.y);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (y2 <= y1) {
    // Y축 겹침 없음 — X/크기가 맞으면 낮은 점수 부여 (Y밀림 허용)
    // 전체 너비 섹션(widthRatio ≥ 0.85)은 Y 거리가 가까우면 추가 점수
    const baseScore = widthRatio * heightRatio * 0.3;
    if (widthRatio >= 0.85) {
      const yCenterA = a.y + a.height / 2;
      const yCenterB = b.y + b.height / 2;
      const maxH = Math.max(a.height, b.height);
      const yDist = Math.abs(yCenterA - yCenterB);
      // Y 중심 거리가 최대 높이의 1배 이내면 점수 보정
      if (yDist < maxH) {
        const yProximity = 1 - yDist / maxH;
        return Math.max(baseScore, widthRatio * heightRatio * (0.3 + yProximity * 0.4));
      }
    }
    return baseScore;
  }
  const inter = xOverlap * (y2 - y1);
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
    classSet: Set<string>;
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
        classSet: new Set(entry.classList),
        computeds: [entry.computed],
        representativeClass: cls,
        textBbox: (entry.textBbox as BboxRect | null) ?? null,
      });
    } else {
      const g = groups.get(key)!;
      for (const c of entry.classList) {
        if (!g.classSet.has(c)) { g.classSet.add(c); g.classList.push(c); }
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


/** Figma 자동 생성 이름 판별 (Frame 12345, Group 3, Rectangle, Vector, Ellipse 등) */
function isAutoGeneratedName(name: string): boolean {
  return /^(Frame|Group|Rectangle|Vector|Ellipse|Line|Polygon|Star|Boolean|Union|Subtract|Intersect|Exclude)\s*\d*$/i.test(name.trim());
}

function cssEscape(s: string) {
  return s.replace(/[^a-zA-Z0-9_-]/g, (m) => `\\${m}`);
}

