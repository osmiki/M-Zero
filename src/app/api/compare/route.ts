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
  childBboxes?: Array<{ x: number; y: number; width: number; height: number }> | null;
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

    const IOU_THRESHOLD = 0.90;

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

      // ── 0순위: 수동 노드-클래스 매핑 ──
      const selector = `.${cssEscape(className)}`;
      const mappedClass = body.nodeClassMapping?.[className];
      if (mappedClass) {
        const mappedEntry = web.elements[mappedClass];
        if (mappedEntry) {
          const out = compareTokenToComputed(t, { classList: mappedEntry.classList, computed: mappedEntry.computed }, compareConfig);
          const fp = mappedEntry.computed?.['_fixedPosition'];
          const mappedBbox = mappedEntry.bbox ?? null;
          results.push({
            className, selector: `.${cssEscape(mappedClass)}`,
            matchedWebClassName: mappedClass,
            severity: out.severity, compareMode,
            matchMethod: "mapping",
            matchScore: 1.0,
            diffs: out.diffs, rows: out.rows,
            bbox: mappedBbox,
            textBbox: mappedEntry.textBbox ?? null,
            childBboxes: mappedBbox ? findFailingChildBboxes(mappedBbox, out.diffs, web.elements) : null,
            fixedPosition: (fp === "top" || fp === "bottom") ? fp : null,
            elementFound: true,
          });
          continue;
        }
      }

      // ── 1순위: 이름 exact match ──
      const directEntry = web.elements[className];
      if (directEntry) {
        const out = compareTokenToComputed(t, { classList: directEntry.classList, computed: directEntry.computed }, compareConfig);
        const fp = directEntry.computed?.['_fixedPosition'];
        const directBbox = directEntry.bbox ?? null;
        results.push({
          className, selector,
          matchedWebClassName: className,
          severity: out.severity, compareMode,
          matchMethod: "name-exact",
          matchScore: 1.0,
          diffs: out.diffs, rows: out.rows,
          bbox: directBbox,
          textBbox: directEntry.textBbox ?? null,
          childBboxes: directBbox ? findFailingChildBboxes(directBbox, out.diffs, web.elements) : null,
          fixedPosition: (fp === "top" || fp === "bottom") ? fp : null,
          elementFound: true,
        });
        continue;
      }

      // ── 2순위: 정규화 이름 매칭 (대소문자/특수문자 제거 후 exact 매칭)
      const canonicalKey = canonicalClassKey(className);
      const normalizedEntry = canonicalKey ? webByCanonical.get(canonicalKey) : null;
      if (normalizedEntry) {
        const out = compareTokenToComputed(t, { classList: normalizedEntry.entry.classList, computed: normalizedEntry.entry.computed }, compareConfig);
        const fp = normalizedEntry.entry.computed?.['_fixedPosition'];
        const normalizedBbox = normalizedEntry.entry.bbox ?? null;
        results.push({
          className, selector: `.${cssEscape(normalizedEntry.originalName)}`,
          matchedWebClassName: normalizedEntry.originalName,
          severity: out.severity, compareMode,
          matchMethod: "name-normalized",
          matchScore: 0.9,
          diffs: out.diffs, rows: out.rows,
          bbox: normalizedBbox,
          textBbox: normalizedEntry.entry.textBbox ?? null,
          childBboxes: normalizedBbox ? findFailingChildBboxes(normalizedBbox, out.diffs, web.elements) : null,
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
          childBboxes: findFailingChildBboxes(iouEntry.bbox, out.diffs, web.elements),
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

// ─── 자식 요소 bbox 탐색 ────────────────────────────────────────────────────────

const TEXT_DIFF_KEYS_SET = new Set([
  "color", "fontSize", "fontWeight", "fontFamily",
  "fontStyle", "textDecoration", "lineHeight", "letterSpacing",
]);

/** child bbox가 parent 안에 충분히 포함되는지 확인 (tolerance: px) */
function isInsideParent(child: BboxRect, parent: BboxRect, tolerance = 8): boolean {
  return (
    child.x >= parent.x - tolerance &&
    child.y >= parent.y - tolerance &&
    child.x + child.width  <= parent.x + parent.width  + tolerance &&
    child.y + child.height <= parent.y + parent.height + tolerance
  );
}

/**
 * 텍스트 관련 diff가 있는 경우, 엄마 bbox 내부에서
 * 실제 failing 텍스트 자식 요소의 bbox 목록을 반환.
 * 없으면 빈 배열 반환 → overlay는 기존 엄마 bbox 사용.
 */
function findFailingChildBboxes(
  parentBbox: BboxRect,
  diffs: Array<{ key: string }>,
  webElements: Record<string, { bbox: any; computed: Record<string, string> }>
): Array<{ x: number; y: number; width: number; height: number }> {
  // 텍스트 관련 diff가 없으면 자식 탐색 불필요
  if (!diffs.some(d => TEXT_DIFF_KEYS_SET.has(d.key))) return [];
  if (parentBbox.width <= 0 || parentBbox.height <= 0) return [];

  const parentArea = parentBbox.width * parentBbox.height;
  // 너무 작은 부모는 자식이 없다고 판단 (예: 단순 텍스트 노드)
  if (parentArea < 1000) return [];

  const seenKeys = new Set<string>();
  const candidates: Array<{ bbox: BboxRect; y: number; area: number }> = [];

  for (const entry of Object.values(webElements)) {
    const b = entry.bbox as BboxRect | null;
    if (!b || b.width <= 2 || b.height <= 2) continue;
    if (!isInsideParent(b, parentBbox)) continue;

    const area = b.width * b.height;
    const areaRatio = area / parentArea;
    // 너무 작거나(3% 미만) 너무 큰(65% 이상) 요소 제외
    if (areaRatio < 0.03 || areaRatio > 0.65) continue;

    // 텍스트 요소 판별: font-size가 있어야 함 (kebab-case, camelCase 둘 다 체크)
    const fs = entry.computed?.["font-size"] ?? entry.computed?.["fontSize"] ?? "";
    if (!fs || fs === "0px" || fs === "0") continue;

    // 동일 bbox 중복 제거
    const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    candidates.push({ bbox: b as BboxRect, y: b.y, area });
  }

  if (candidates.length === 0) return [];

  // Y 위치 오름차순 정렬 (위에 있는 요소 = 제목 우선), 같은 Y면 큰 면적 우선
  candidates.sort((a, b_) => a.y !== b_.y ? a.y - b_.y : b_.area - a.area);

  // 엄마 높이의 상위 35% 영역을 "타이틀 존"으로 간주
  const titleZoneBottom = parentBbox.y + parentBbox.height * 0.35;
  const inTitleZone = candidates.filter(c => c.bbox.y + c.bbox.height <= titleZoneBottom);

  const picked = (inTitleZone.length > 0 ? inTitleZone : candidates).slice(0, 3);
  return picked.map(c => c.bbox);
}

