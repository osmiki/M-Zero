import { z } from "zod";
import { normalizeColorToHex, roundPx } from "@/lib/normalize";

const NodeResponseSchema = z.object({
  nodes: z.record(
    z.string(),
    z.object({
      document: z.any(),
      /** Figma Named Color/Typography Styles referenced in this subtree.
       *  Key = styleKey (matches node.styles.fill / node.styles.text value) */
      styles: z.record(z.string(), z.any()).optional(),
    })
  ),
});

export type FigmaToken = {
  className: string;
  /** Figma 노드 타입: "COMPONENT" | "INSTANCE" | "COMPONENT_SET" | "FRAME" | "TEXT" | 등 */
  nodeType: string;
  /** COMPONENT/INSTANCE 계층 안에 있는 노드 여부 — true면 strict 비교 */
  insideComponent?: boolean;
  /**
   * COMPONENT/INSTANCE 내부 자식 트리에서 재귀적으로 수집한 Foundation 값.
   * 레이아웃(padding/gap)은 제외하고, 브랜드 가이드(폰트·컬러·선·그림자)만 포함.
   */
  childFoundation?: {
    color?: string | null;
    fontSize?: number | null;
    fontWeight?: number | null;
    fontFamily?: string | null;
    lineHeightPx?: number | null;
    letterSpacingPx?: number | null;
    strokeWidth?: number | null;
    strokeColor?: string | null;
    shadow?: { x: number; y: number; blur: number; spread: number; color: string; inset: boolean } | null;
  } | null;
  /**
   * COMPONENT/INSTANCE 내부 모든 TEXT 자식 노드 목록 (순서 보존).
   * Scoring 알고리즘에서 웹 텍스트 자식과 매칭할 때 사용.
   */
  childTextNodes?: Array<{
    name: string;
    characters: string;
    index: number;
    fontSize?: number | null;
    fontWeight?: number | null;
    fontFamily?: string | null;
    lineHeightPx?: number | null;
    letterSpacingPx?: number | null;
    color?: string | null;
  }> | null;
  figmaBbox?: { x: number; y: number; width: number; height: number } | null;
  figma: {
    width?: number | null;
    height?: number | null;
    itemSpacing?: number | null;
    padding?: { top: number; right: number; bottom: number; left: number } | null;
    fontSize?: number | null;
    fontWeight?: number | null;
    fontFamily?: string | null;
    fontStyle?: string | null;
    textDecoration?: string | null;
    lineHeightPx?: number | null;
    letterSpacingPx?: number | null;
    color?: string | null;
    /** Figma Named Color Style 이름 (예: "Colors/Gray 900" → "Gray 900") */
    colorToken?: string | null;
    backgroundColor?: string | null;
    backgroundColorToken?: string | null;
    cornerRadius?: number | null;
    opacity?: number | null;
    strokeWidth?: number | null;
    strokeColor?: string | null;
    shadow?: { x: number; y: number; blur: number; spread: number; color: string; inset: boolean } | null;
    expectedTag?: string | null;
    animationClassHints?: string[] | null;
  };
};

export function parseFigmaDevModeUrl(input: string): { fileKey: string | null; nodeId: string | null } {
  const trimmed = input.trim();
  if (!trimmed.startsWith("http")) return { fileKey: null, nodeId: null };
  try {
    const u = new URL(trimmed);
    const parts = u.pathname.split("/").filter(Boolean);
    // Figma URL patterns:
    // - https://www.figma.com/file/<fileKey>/... ?node-id=...
    // - https://www.figma.com/design/<fileKey>/... ?node-id=...
    const keyIdx = (() => {
      const fileIdx = parts.findIndex((p) => p === "file");
      if (fileIdx >= 0) return fileIdx + 1;
      const designIdx = parts.findIndex((p) => p === "design");
      if (designIdx >= 0) return designIdx + 1;
      return -1;
    })();
    const fileKey = keyIdx >= 0 && parts[keyIdx] ? parts[keyIdx] : null;
    const rawNodeId = u.searchParams.get("node-id") ?? u.searchParams.get("node_id");
    const nodeId = rawNodeId ? normalizeNodeId(rawNodeId) : null;
    return { fileKey, nodeId };
  } catch {
    return { fileKey: null, nodeId: null };
  }
}

export function normalizeNodeId(input: string): string {
  // Dev Mode URLs often use "500-3259", but API expects "500:3259"
  const raw = String(input).trim();
  if (!raw) return raw;
  // Allow users to paste examples like "예: 12-345" or include stray characters.
  const s = raw.replace(/\s+/g, "");
  if (!s) return s;
  const m = s.match(/(\d+)\s*[:-]\s*(\d+)/);
  if (m) return `${m[1]}:${m[2]}`;
  // If it already contains colon but didn't match (e.g. "node-id=12:34"), extract digits.
  const m2 = s.match(/(\d+):(\d+)/);
  if (m2) return `${m2[1]}:${m2[2]}`;
  return raw;
}

export async function extractFigmaTokensFromNode(args: {
  personalAccessToken: string;
  fileKey: string;
  nodeId: string;
  maxTokens?: number;
}): Promise<{ tokens: FigmaToken[] }> {
  const url = `https://api.figma.com/v1/files/${encodeURIComponent(args.fileKey)}/nodes?ids=${encodeURIComponent(
    args.nodeId
  )}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, {
      headers: { "X-Figma-Token": args.personalAccessToken },
      cache: "no-store",
    }, 25_000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      [
        "Figma API 네트워크 요청에 실패했습니다.",
        `원인: ${msg}`,
        "가능한 원인: 네트워크 정책/방화벽, 샌드박스 제한, 일시적 네트워크 장애",
      ].join("\n")
    );
  }

  if (res.status === 401 || res.status === 403) {
    const text = await safeReadText(res);
    throw new Error(
      [
        "Figma API 권한이 없습니다. Personal Access Token을 확인해주세요.",
        `HTTP ${res.status}`,
        text ? `응답: ${truncate(text, 240)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(
      ["Figma API 호출 실패", `HTTP ${res.status}`, text ? `응답: ${truncate(text, 240)}` : ""]
        .filter(Boolean)
        .join("\n")
    );
  }

  const json = NodeResponseSchema.parse(await res.json());
  const nodeWrap = json.nodes[args.nodeId];
  if (!nodeWrap?.document) throw new Error("Figma node document를 찾지 못했습니다.");

  // Named Color Styles dict: styleKey → display name
  // "Colors/Gray 900" → last segment → "Gray 900"
  const stylesDict = nodeWrap.styles ?? {};
  const getStyleTokenName = (styleRef: string | undefined): string | null => {
    if (!styleRef) return null;
    const entry = stylesDict[styleRef];
    if (!entry?.name) return null;
    const parts = entry.name.split("/");
    return parts[parts.length - 1].trim() || null;
  };

  const max = typeof args.maxTokens === "number" && args.maxTokens > 0 ? Math.floor(args.maxTokens) : 500;

  // Pre-pass: COMPONENT 노드의 stroke + 텍스트 색상 데이터 수집
  // INSTANCE 노드는 Figma REST API에서 strokes/fills: [] 로 반환될 수 있음
  // (컴포넌트에 정의돼 있고 인스턴스에 override가 없을 때)
  // → 같은 subtree에 COMPONENT가 있으면 데이터를 상속
  const componentStrokeMap = new Map<string, { strokeWeight: number; strokes: any[] }>();
  // componentId:childTextName → resolved color hex
  const componentTextColorMap = new Map<string, string | null>();
  {
    const preStack: any[] = [nodeWrap.document];
    while (preStack.length) {
      const n = preStack.pop();
      if (!n) continue;
      if (n.id && n.type === "COMPONENT") {
        // stroke 수집
        if (n.strokeWeight != null && Array.isArray(n.strokes) && n.strokes.length > 0) {
          componentStrokeMap.set(n.id, { strokeWeight: n.strokeWeight, strokes: n.strokes });
        }
        // 자식 TEXT 노드의 색상 수집 (재귀적으로 모든 TEXT 자손 포함)
        const collectTextColors = (children: any[], componentId: string) => {
          for (const child of children) {
            if (!child) continue;
            if (child.type === "TEXT") {
              const color = extractSolidFillColor(child);
              if (color) {
                componentTextColorMap.set(`${componentId}:${child.name}`, normalizeColorToHex(color));
              }
            }
            if (Array.isArray(child.children)) collectTextColors(child.children, componentId);
          }
        };
        if (Array.isArray(n.children)) collectTextColors(n.children, n.id);
      } else if (
        n.id &&
        n.type === "FRAME" &&
        n.strokeWeight != null &&
        Array.isArray(n.strokes) &&
        n.strokes.length > 0
      ) {
        componentStrokeMap.set(n.id, { strokeWeight: n.strokeWeight, strokes: n.strokes });
      }
      const children: any[] = Array.isArray(n?.children) ? n.children : [];
      for (let i = children.length - 1; i >= 0; i--) preStack.push(children[i]);
    }
  }

  // Iterative walk with early stop to avoid blocking event loop on huge frames.
  // 스택에 {node, parentInstanceComponentId} 쌍을 저장해 INSTANCE 상속 해결
  const uniq = new Map<string, FigmaToken>();
  const stack: Array<{ node: any; parentCompId: string | null }> = [{ node: nodeWrap.document, parentCompId: null }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) continue;
    const { node: n, parentCompId } = item;
    if (!n) continue;

    // visibility가 꺼진 노드와 그 하위 트리 전체 스킵
    if (n.visible === false) continue;

    const name = typeof n?.name === "string" ? n.name.trim() : "";
    if (name && !uniq.has(name)) {
      const abs = n.absoluteBoundingBox;
      const rawFillColor = extractSolidFillColor(n);

      // CSS color (텍스트 색) = Figma TEXT 노드의 fill에서만 추출
      // CSS backgroundColor = 컨테이너 노드(FRAME/RECT/COMP/INSTANCE)의 fill에서 추출
      const isTextNode = n.type === "TEXT";
      const isContainerNode =
        n.type === "FRAME" ||
        n.type === "RECTANGLE" ||
        n.type === "COMPONENT" ||
        n.type === "INSTANCE" ||
        n.type === "COMPONENT_SET";

      // TEXT의 fills: [] → 부모 INSTANCE의 COMPONENT에서 상속된 색상 해결
      let figmaColor: ReturnType<typeof extractSolidFillColor> = isTextNode ? rawFillColor : null;
      if (isTextNode && !figmaColor && parentCompId) {
        const inherited = componentTextColorMap.get(`${parentCompId}:${name}`);
        if (inherited !== undefined) figmaColor = inherited;
      }

      const backgroundColor = isContainerNode ? rawFillColor : null;

      const padding =
        n.paddingLeft != null
          ? {
              top: num(n.paddingTop),
              right: num(n.paddingRight),
              bottom: num(n.paddingBottom),
              left: num(n.paddingLeft),
            }
          : null;

      // Figma Named Style 토큰명 추출
      // n.styles.fill  → 색상(fill) 스타일 참조 (TEXT/컨테이너 모두)
      // n.styles.text  → 타이포그래피 스타일 참조 (R_1 같은 폰트 스타일 — 색상 아님)
      const fillStyleRef = n.styles?.fill;
      // TEXT 노드의 글자색도 fill 스타일에서 가져옴 (text 스타일은 타이포그래피용)
      const colorTokenName = isTextNode ? getStyleTokenName(fillStyleRef) : null;
      const bgTokenName = isContainerNode ? getStyleTokenName(fillStyleRef) : null;

      const token: FigmaToken = {
        className: name,
        nodeType: n.type ?? "UNKNOWN",
        insideComponent: parentCompId != null,
        figmaBbox: abs
          ? { x: roundPx(abs.x), y: roundPx(abs.y), width: roundPx(abs.width), height: roundPx(abs.height) }
          : null,
        figma: {
          width: abs?.width != null ? roundPx(abs.width) : null,
          height: abs?.height != null ? roundPx(abs.height) : null,
          itemSpacing: n.itemSpacing != null ? roundPx(n.itemSpacing) : null,
          padding,
          fontSize: n.style?.fontSize != null ? roundPx(n.style.fontSize) : null,
          fontWeight: resolveFontWeight(n),
          fontFamily: n.style?.fontFamily ?? null,
          // Figma fontStyle은 "Regular", "Bold", "Medium Italic" 같은 variant 이름.
          // CSS font-style은 "normal" / "italic" / "oblique" 만 있으므로
          // italic이 포함된 variant만 "italic"으로 기록하고, 그 외(Regular, Bold 등)는 null.
          fontStyle: (n.style?.italic || n.style?.fontStyle?.toLowerCase().includes("italic"))
            ? "italic"
            : null,
          textDecoration: n.style?.textDecoration != null && n.style.textDecoration !== "NONE"
            ? n.style.textDecoration.toLowerCase()
            : null,
          lineHeightPx:
            n.style?.lineHeightPx != null
              ? roundPx(n.style.lineHeightPx)
              : n.style?.lineHeight?.value != null && n.style?.fontSize != null
                ? roundPx((n.style.lineHeight.value / 100) * n.style.fontSize)
                : null,
          letterSpacingPx:
            n.style?.letterSpacing != null
              ? n.style.letterSpacing.unit === "PERCENT" && n.style?.fontSize != null
                ? roundPx((n.style.letterSpacing.value / 100) * n.style.fontSize)
                : roundPx(n.style.letterSpacing.value)
              : null,
          color: figmaColor ? normalizeColorToHex(figmaColor) : null,
          colorToken: colorTokenName,
          backgroundColor: backgroundColor ? normalizeColorToHex(backgroundColor) : null,
          backgroundColorToken: bgTokenName,
          cornerRadius:
            n.cornerRadius != null
              ? roundPx(n.cornerRadius)
              : typeof n.rectangleCornerRadii?.[0] === "number"
                ? roundPx(n.rectangleCornerRadii[0])
                : null,
          opacity: n.opacity != null ? Number(n.opacity) : null,
          strokeWidth: resolveStrokeWidth(n, componentStrokeMap),
          strokeColor: resolveStrokeColor(n, componentStrokeMap),
          shadow: extractShadow(n),
          expectedTag: inferExpectedTag(name, n.type),
          animationClassHints: inferAnimationClassHints(name),
        },
        // COMPONENT/INSTANCE: 내부 자식 트리에서 Foundation 값 재귀 수집
        childFoundation:
          n.type === "COMPONENT" || n.type === "INSTANCE"
            ? extractChildFoundation(
                Array.isArray(n.children) ? n.children : [],
                n.type === "INSTANCE" ? (n.componentId ?? null) : (n.id ?? null),
                componentTextColorMap
              )
            : undefined,
        // COMPONENT/INSTANCE: 모든 TEXT 자식 노드 배열 (Scoring 매칭용)
        childTextNodes:
          n.type === "COMPONENT" || n.type === "INSTANCE"
            ? extractChildTextNodes(Array.isArray(n.children) ? n.children : [])
            : undefined,
      };

      uniq.set(name, token);
      if (uniq.size >= max) break;
    }

    // 자식 노드에 parentCompId 전달: INSTANCE이면 componentId, 아니면 그대로 상속
    const childCompId = n.type === "INSTANCE" && n.componentId ? n.componentId : parentCompId;
    const children: any[] = Array.isArray(n?.children) ? n.children : [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentCompId: childCompId });
    }
  }

  return { tokens: Array.from(uniq.values()) };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export async function assertPersonalAccessToken(token: string): Promise<void> {
  // We intentionally only use X-Figma-Token to avoid environment-specific Bearer behavior.
  const url = "https://api.figma.com/v1/me";
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { "X-Figma-Token": token }, cache: "no-store" },
      12_000
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      ["Figma 토큰 검증에 실패했습니다(네트워크).", `원인: ${msg}`].join("\n")
    );
  }

  if (res.ok) return;

  const text = await safeReadText(res);
  const lower = text.toLowerCase();
  if ((res.status === 401 || res.status === 403) && lower.includes("invalid token")) {
    throw new Error(
      [
        "입력한 토큰이 Figma Personal Access Token으로 인증되지 않습니다.",
        "토큰이 잘렸거나(… 포함), 앞/뒤 공백·개행이 포함됐거나, 폐기된 토큰일 수 있습니다.",
        `HTTP ${res.status}`,
        text ? `응답: ${truncate(text, 240)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error(
      [
        "Figma 토큰 검증에 실패했습니다(권한).",
        `HTTP ${res.status}`,
        text ? `응답: ${truncate(text, 240)}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  throw new Error(
    ["Figma 토큰 검증에 실패했습니다.", `HTTP ${res.status}`, text ? `응답: ${truncate(text, 240)}` : ""]
      .filter(Boolean)
      .join("\n")
  );
}

export async function fetchFigmaFramePng(args: {
  personalAccessToken: string;
  fileKey: string;
  nodeId: string; // colon format e.g. "0:2789"
  scale?: number;
}): Promise<string | null> {
  try {
    const scale = args.scale ?? 2;
    const url = `https://api.figma.com/v1/images/${encodeURIComponent(args.fileKey)}?ids=${encodeURIComponent(args.nodeId)}&format=png&scale=${scale}`;
    const res = await fetchWithTimeout(url, { headers: { "X-Figma-Token": args.personalAccessToken }, cache: "no-store" }, 20_000);
    if (!res.ok) return null;
    const json = await res.json() as { images?: Record<string, string | null> };
    const cdnUrl = json.images?.[args.nodeId] ?? null;
    if (!cdnUrl) return null;
    const imgRes = await fetchWithTimeout(cdnUrl, {}, 20_000);
    if (!imgRes.ok) return null;
    const buffer = await imgRes.arrayBuffer();
    return Buffer.from(buffer).toString("base64");
  } catch {
    return null;
  }
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function extractStrokeColor(n: any): string | null {
  const strokes = Array.isArray(n?.strokes) ? n.strokes : [];
  const solid = strokes.find((s: any) => s?.visible !== false && s?.type === "SOLID" && s?.color);
  if (!solid?.color) return null;
  const { r, g, b } = solid.color;
  const a = solid.opacity != null ? solid.opacity : solid.color?.a;
  const rgba = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`;
  return normalizeColorToHex(rgba);
}

/** INSTANCE 노드의 strokes가 비어있을 때 같은 subtree의 COMPONENT에서 stroke 상속 */
function getEffectiveStrokeSource(
  n: any,
  componentStrokeMap: Map<string, { strokeWeight: number; strokes: any[] }>
): { strokeWeight: number | null | undefined; strokes: any[] } {
  const strokes = Array.isArray(n?.strokes) ? n.strokes : [];
  if (strokes.length > 0) return { strokeWeight: n.strokeWeight, strokes };
  // INSTANCE: componentId로 컴포넌트 stroke 조회
  if (n?.type === "INSTANCE" && n.componentId) {
    const comp = componentStrokeMap.get(n.componentId);
    if (comp) return { strokeWeight: comp.strokeWeight, strokes: comp.strokes };
  }
  return { strokeWeight: null, strokes: [] };
}

function resolveStrokeWidth(
  n: any,
  componentStrokeMap: Map<string, { strokeWeight: number; strokes: any[] }>
): number | null {
  const { strokeWeight, strokes } = getEffectiveStrokeSource(n, componentStrokeMap);
  if (strokeWeight != null && strokes.some((s: any) => s?.visible !== false)) {
    return roundPx(strokeWeight);
  }
  return null;
}

function resolveStrokeColor(
  n: any,
  componentStrokeMap: Map<string, { strokeWeight: number; strokes: any[] }>
): string | null {
  const { strokes } = getEffectiveStrokeSource(n, componentStrokeMap);
  return extractStrokeColor({ strokes });
}

function extractSolidFillColor(n: any): string | null {
  const fills = Array.isArray(n?.fills) ? n.fills : [];
  const solid = fills.find((f: any) => f?.visible !== false && f?.type === "SOLID" && f?.color);
  if (!solid?.color) return null;
  const { r, g, b } = solid.color;
  const a = solid.opacity != null ? solid.opacity : solid.color?.a;
  const rgba = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`;
  return rgba;
}

/**
 * Figma 노드명 + 타입으로 기대되는 HTML 태그를 추론
 * 반환값: "button|a" 형태의 파이프 구분 허용 태그 목록, null이면 체크 안 함
 */
function inferExpectedTag(name: string, nodeType: string): string | null {
  const lower = name.toLowerCase();
  const isComponent = nodeType === "COMPONENT" || nodeType === "INSTANCE" || nodeType === "COMPONENT_SET";

  // 시맨틱 태그 추론은 Figma COMPONENT / INSTANCE 노드에만 적용
  // 일반 FRAME / GROUP 레이어는 이름이 btn이어도 체크하지 않음
  if (isComponent) {
    // 버튼: button, btn, cta 포함 → <button> 또는 <a>
    if (/\b(button|btn|cta)\b/.test(lower)) return "button|a";
    // 링크: link 포함
    if (/\blink\b/.test(lower)) return "a";
    // 인풋: input, textfield, text-field → <input> 또는 <textarea>
    if (/\b(input|textfield|text.?field)\b/.test(lower)) return "input|textarea";
    // 체크박스/라디오
    if (/\bcheckbox\b/.test(lower)) return "input";
    if (/\bradio\b/.test(lower)) return "input";
    // 셀렉트/드롭다운
    if (/\b(select|dropdown|drop.?down)\b/.test(lower)) return "select|button";
    // 이미지
    if (/\b(image|img|photo|thumbnail|thumb)\b/.test(lower)) return "img";
  }

  // Figma TEXT 노드는 타입 자체로 판단 (컴포넌트 여부 무관)
  if (nodeType === "TEXT") return "p|span|h1|h2|h3|h4|h5|h6|label|li|a";
  return null;
}

function inferAnimationClassHints(name: string): string[] | null {
  // MVP: if token name contains known animation tokens, treat them as "must include in classList"
  const hints = ["fade-in", "btn-hover", "slide-up", "scale-in"].filter((k) => name.includes(k));
  return hints.length ? hints : null;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 텍스트 노드의 fontWeight를 결정.
 * characterStyleOverrides가 있는 혼합 스타일 텍스트의 경우
 * n.style.fontWeight는 첫 글자 기준이라 부정확하므로,
 * 실제 글자별 override를 집계해 가장 많이 사용된 fontWeight를 반환.
 */
function resolveFontWeight(n: any): number | null {
  const baseWeight = n.style?.fontWeight != null ? Number(n.style.fontWeight) : null;
  if (baseWeight == null) return null;

  const overrides: number[] = Array.isArray(n.characterStyleOverrides) ? n.characterStyleOverrides : [];
  const table: Record<string, any> = n.styleOverrideTable ?? {};

  if (overrides.length === 0) return baseWeight;

  // 글자별 실제 fontWeight 집계 (override 없는 글자는 baseWeight 사용)
  const counts = new Map<number, number>();
  for (const idx of overrides) {
    const w = idx === 0 ? baseWeight : (table[String(idx)]?.fontWeight != null ? Number(table[String(idx)].fontWeight) : baseWeight);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  // override가 없는 글자 수 (전체 문자 - override 배열 길이)
  const totalChars = typeof n.characters === "string" ? n.characters.length : overrides.length;
  const noOverrideCount = Math.max(0, totalChars - overrides.length);
  if (noOverrideCount > 0) counts.set(baseWeight, (counts.get(baseWeight) ?? 0) + noOverrideCount);

  // 가장 많이 사용된 fontWeight 반환
  let maxCount = 0;
  let dominant = baseWeight;
  for (const [w, c] of counts) {
    if (c > maxCount) { maxCount = c; dominant = w; }
  }
  return dominant;
}

/** Figma effects 배열에서 첫 번째 visible 드롭/이너 섀도우 추출 */
function extractShadow(n: any): { x: number; y: number; blur: number; spread: number; color: string; inset: boolean } | null {
  const effects = Array.isArray(n?.effects) ? n.effects : [];
  const shadow = effects.find(
    (e: any) => (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible !== false
  );
  if (!shadow) return null;
  const { r, g, b } = shadow.color ?? {};
  if (r == null) return null;
  const a = shadow.color?.a ?? 1;
  const color = normalizeColorToHex(
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`
  );
  return {
    x: roundPx(shadow.offset?.x ?? 0),
    y: roundPx(shadow.offset?.y ?? 0),
    blur: roundPx(shadow.radius ?? 0),
    spread: roundPx(shadow.spread ?? 0),
    color: color ?? "#000000ff",
    inset: shadow.type === "INNER_SHADOW",
  };
}

/**
 * COMPONENT/INSTANCE 내부 자식 트리를 재귀 순회해 Foundation 값 수집.
 * TEXT → Typography + color / 모든 노드 → stroke, shadow
 * 레이아웃(padding/gap) 제외 — 브랜드 가이드(폰트·컬러·선·그림자)만 포함.
 */
function extractChildFoundation(
  children: any[],
  componentId: string | null,
  componentTextColorMap: Map<string, string | null>
): FigmaToken["childFoundation"] {
  const cf: NonNullable<FigmaToken["childFoundation"]> = {};

  const stack: any[] = [...children].reverse();
  while (stack.length) {
    const n = stack.pop();
    if (!n || n.visible === false) continue;

    if (n.type === "TEXT") {
      if (cf.fontSize == null && n.style?.fontSize != null) cf.fontSize = roundPx(n.style.fontSize);
      if (cf.fontWeight == null) { const fw = resolveFontWeight(n); if (fw != null) cf.fontWeight = fw; }
      if (cf.fontFamily == null && n.style?.fontFamily) cf.fontFamily = n.style.fontFamily;
      if (cf.lineHeightPx == null && n.style?.lineHeightPx != null) cf.lineHeightPx = roundPx(n.style.lineHeightPx);
      if (cf.letterSpacingPx == null && n.style?.letterSpacing != null) {
        cf.letterSpacingPx = n.style.letterSpacing.unit === "PERCENT" && n.style?.fontSize
          ? roundPx((n.style.letterSpacing.value / 100) * n.style.fontSize)
          : roundPx(n.style.letterSpacing.value);
      }
      if (cf.color == null) {
        const raw = extractSolidFillColor(n);
        if (raw) {
          cf.color = normalizeColorToHex(raw);
        } else if (componentId) {
          const inherited = componentTextColorMap.get(`${componentId}:${n.name}`);
          if (inherited) cf.color = inherited;
        }
      }
    }

    // Stroke — 어느 노드에서든 stroke 수집
    if (cf.strokeWidth == null && n.strokeWeight != null) {
      const strokes: any[] = Array.isArray(n.strokes) ? n.strokes : [];
      const solid = strokes.find((s: any) => s?.visible !== false && s?.type === "SOLID" && s?.color);
      if (solid) {
        cf.strokeWidth = roundPx(n.strokeWeight);
        const { r, g, b } = solid.color;
        const a = solid.opacity ?? solid.color?.a ?? 1;
        cf.strokeColor = normalizeColorToHex(
          `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`
        );
      }
    }

    // Shadow/effects
    if (cf.shadow == null) {
      const s = extractShadow(n);
      if (s) cf.shadow = s;
    }

    if (Array.isArray(n.children)) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }

  const hasData = Object.values(cf).some((v) => v != null);
  return hasData ? cf : null;
}

/**
 * COMPONENT/INSTANCE 내부 모든 TEXT 자식 노드를 순서대로 수집.
 * 순서(index)와 실제 텍스트 내용(characters)을 포함해 Scoring 매칭에 활용.
 */
function extractChildTextNodes(children: any[]): FigmaToken["childTextNodes"] {
  const result: NonNullable<FigmaToken["childTextNodes"]> = [];
  let index = 0;
  const stack: any[] = [...children].reverse();
  while (stack.length) {
    const n = stack.pop();
    if (!n || n.visible === false) continue;
    if (n.type === "TEXT") {
      const fw = resolveFontWeight(n);
      const lsp =
        n.style?.letterSpacing != null
          ? n.style.letterSpacing.unit === "PERCENT" && n.style?.fontSize != null
            ? roundPx((n.style.letterSpacing.value / 100) * n.style.fontSize)
            : roundPx(n.style.letterSpacing.value)
          : null;
      const rawColor = extractSolidFillColor(n);
      result.push({
        name: n.name ?? "",
        characters: n.characters ?? "",
        index: index++,
        fontSize: n.style?.fontSize != null ? roundPx(n.style.fontSize) : null,
        fontWeight: fw ?? null,
        fontFamily: n.style?.fontFamily ?? null,
        lineHeightPx: n.style?.lineHeightPx != null ? roundPx(n.style.lineHeightPx) : null,
        letterSpacingPx: lsp,
        color: rawColor ? normalizeColorToHex(rawColor) : null,
      });
    }
    if (Array.isArray(n.children)) {
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  return result.length > 0 ? result : null;
}

