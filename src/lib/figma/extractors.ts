import { z } from "zod";
import { normalizeColorToHex, roundPx } from "@/lib/normalize";
import type { FigmaToken } from "./types";
import { fetchWithTimeout, safeReadText, truncate } from "./api";

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

  // hex → tokenName 맵: n.styles?.fill이 있는 노드에서만 구축 (트리 워크)
  const colorTokenMap = new Map<string, string>();
  {
    const walkStack: any[] = [nodeWrap.document];
    while (walkStack.length) {
      const n = walkStack.pop();
      if (!n || n.visible === false) continue;
      if (n.styles?.fill) {
        const tokenName = getStyleTokenName(n.styles.fill);
        if (tokenName) {
          const rawColor = extractSolidFillColor(n);
          if (rawColor) {
            const hex = normalizeColorToHex(rawColor);
            if (hex && !colorTokenMap.has(hex)) colorTokenMap.set(hex, tokenName);
          }
        }
      }
      if (Array.isArray(n?.children)) {
        for (let i = n.children.length - 1; i >= 0; i--) walkStack.push(n.children[i]);
      }
    }
  }

  const max = typeof args.maxTokens === "number" && args.maxTokens > 0 ? Math.floor(args.maxTokens) : 500;

  // Pre-pass: COMPONENT 노드의 stroke + 텍스트 색상 데이터 수집
  const componentStrokeMap = new Map<string, { strokeWeight: number; strokes: any[] }>();
  const componentTextColorMap = new Map<string, string | null>();
  // COMPONENT TEXT 자식의 Named Color Style 토큰명 (인스턴스 상속값 추적용)
  const componentTextColorTokenMap = new Map<string, string | null>();
  {
    const preStack: any[] = [nodeWrap.document];
    while (preStack.length) {
      const n = preStack.pop();
      if (!n) continue;
      if (n.id && n.type === "COMPONENT") {
        if (n.strokeWeight != null && Array.isArray(n.strokes) && n.strokes.length > 0) {
          componentStrokeMap.set(n.id, { strokeWeight: n.strokeWeight, strokes: n.strokes });
        }
        const collectTextColors = (children: any[], componentId: string) => {
          for (const child of children) {
            if (!child) continue;
            if (child.type === "TEXT") {
              const color = extractSolidFillColor(child);
              if (color) {
                componentTextColorMap.set(`${componentId}:${child.name}`, normalizeColorToHex(color));
              }
              // Named Color Style 토큰명도 수집 (COMPONENT 정의에서만 styles.fill이 있음)
              const tokenName = getStyleTokenName(child.styles?.fill);
              if (tokenName) {
                componentTextColorTokenMap.set(`${componentId}:${child.name}`, tokenName);
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

  // Iterative walk with early stop
  const uniq = new Map<string, FigmaToken>();
  const stack: Array<{ node: any; parentCompId: string | null }> = [{ node: nodeWrap.document, parentCompId: null }];
  while (stack.length) {
    const item = stack.pop();
    if (!item) continue;
    const { node: n, parentCompId } = item;
    if (!n) continue;

    if (n.visible === false) continue;

    const name = typeof n?.name === "string" ? n.name.trim() : "";
    if (name && !uniq.has(name)) {
      const abs = n.absoluteBoundingBox;
      const rawFillColor = extractSolidFillColor(n);

      const isTextNode = n.type === "TEXT";
      const isContainerNode =
        n.type === "FRAME" ||
        n.type === "RECTANGLE" ||
        n.type === "COMPONENT" ||
        n.type === "INSTANCE" ||
        n.type === "COMPONENT_SET";

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

      const fillStyleRef = n.styles?.fill;
      // 1순위: styles.fill 직접 참조 / 2순위: hex → tokenName 역방향 맵
      const rawColorHex = rawFillColor ? normalizeColorToHex(rawFillColor) : null;
      const colorTokenName = isTextNode
        ? (getStyleTokenName(fillStyleRef) ?? (rawColorHex ? colorTokenMap.get(rawColorHex) ?? null : null))
        : null;
      const bgTokenName = isContainerNode
        ? (getStyleTokenName(fillStyleRef) ?? (rawColorHex ? colorTokenMap.get(rawColorHex) ?? null : null))
        : null;

      const token: FigmaToken = {
        className: name,
        nodeType: n.type ?? "UNKNOWN",
        insideComponent: parentCompId != null,
        characters: isTextNode ? (n.characters ?? null) : null,
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
          // Layout properties
          layoutMode: n.layoutMode ?? null,
          primaryAxisAlignItems: n.primaryAxisAlignItems ?? null,
          counterAxisAlignItems: n.counterAxisAlignItems ?? null,
          textAlignHorizontal: n.style?.textAlignHorizontal ?? null,
          textCase: n.style?.textCase ?? null,
        },
        childFoundation:
          n.type === "COMPONENT" || n.type === "INSTANCE"
            ? extractChildFoundation(
                Array.isArray(n.children) ? n.children : [],
                n.type === "INSTANCE" ? (n.componentId ?? null) : (n.id ?? null),
                componentTextColorMap,
                stylesDict,
                componentTextColorTokenMap,
                colorTokenMap
              )
            : undefined,
        childTextNodes:
          n.type === "COMPONENT" || n.type === "INSTANCE"
            ? extractChildTextNodes(Array.isArray(n.children) ? n.children : [])
            : undefined,
      };

      uniq.set(name, token);
      if (uniq.size >= max) break;
    }

    const childCompId = n.type === "INSTANCE" && n.componentId ? n.componentId : parentCompId;
    const children: any[] = Array.isArray(n?.children) ? n.children : [];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], parentCompId: childCompId });
    }
  }

  // 디버그: 색상 토큰 맵 내용 + 빌드 과정 상세 정보
  return { tokens: Array.from(uniq.values()) };
}

// ---------------------------------------------------------------------------
// Internal extraction helpers
// ---------------------------------------------------------------------------

export function extractSolidFillColor(n: any): string | null {
  const fills = Array.isArray(n?.fills) ? n.fills : [];
  const solid = fills.find((f: any) => f?.visible !== false && f?.type === "SOLID" && f?.color);
  if (!solid?.color) return null;
  const { r, g, b } = solid.color;
  const a = solid.opacity != null ? solid.opacity : solid.color?.a;
  const rgba = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`;
  return rgba;
}

export function extractStrokeColor(n: any): string | null {
  const strokes = Array.isArray(n?.strokes) ? n.strokes : [];
  const solid = strokes.find((s: any) => s?.visible !== false && s?.type === "SOLID" && s?.color);
  if (!solid?.color) return null;
  const { r, g, b } = solid.color;
  const a = solid.opacity != null ? solid.opacity : solid.color?.a;
  const rgba = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a ?? 1})`;
  return normalizeColorToHex(rgba);
}

/** Figma effects 배열에서 첫 번째 visible 드롭/이너 섀도우 추출 */
export function extractShadow(n: any): { x: number; y: number; blur: number; spread: number; color: string; inset: boolean } | null {
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
 */
export function extractChildFoundation(
  children: any[],
  componentId: string | null,
  componentTextColorMap: Map<string, string | null>,
  stylesDict?: Record<string, any>,
  componentTextColorTokenMap?: Map<string, string | null>,
  colorTokenMap?: Map<string, string>
): FigmaToken["childFoundation"] {
  const cf: NonNullable<FigmaToken["childFoundation"]> = {};

  // stylesDict에서 토큰명 추출 헬퍼
  const getTokenName = (styleRef: string | undefined): string | null => {
    if (!styleRef || !stylesDict) return null;
    const entry = stylesDict[styleRef];
    if (!entry?.name) return null;
    const parts = entry.name.split("/");
    return parts[parts.length - 1].trim() || null;
  };

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
          // 1순위: 인스턴스 오버라이드에 styles.fill이 있으면 직접 추출
          if (cf.colorToken == null) {
            cf.colorToken = getTokenName(n.styles?.fill);
          }
          // 2순위: COMPONENT 정의에서 미리 수집한 토큰명
          if (cf.colorToken == null && componentId) {
            cf.colorToken = componentTextColorTokenMap?.get(`${componentId}:${n.name}`) ?? null;
          }
          // 3순위: 파일 전체 색상 토큰 맵으로 hex 역조회
          if (cf.colorToken == null && colorTokenMap) {
            cf.colorToken = colorTokenMap.get(cf.color!) ?? null;
          }
        } else if (componentId) {
          const inherited = componentTextColorMap.get(`${componentId}:${n.name}`);
          if (inherited) {
            cf.color = inherited;
            if (cf.colorToken == null) {
              cf.colorToken = componentTextColorTokenMap?.get(`${componentId}:${n.name}`)
                ?? (colorTokenMap?.get(inherited) ?? null);
            }
          }
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
 */
export function extractChildTextNodes(children: any[]): FigmaToken["childTextNodes"] {
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

// ---------------------------------------------------------------------------
// Private helpers used within extractors
// ---------------------------------------------------------------------------

/** INSTANCE 노드의 strokes가 비어있을 때 같은 subtree의 COMPONENT에서 stroke 상속 */
function getEffectiveStrokeSource(
  n: any,
  componentStrokeMap: Map<string, { strokeWeight: number; strokes: any[] }>
): { strokeWeight: number | null | undefined; strokes: any[] } {
  const strokes = Array.isArray(n?.strokes) ? n.strokes : [];
  if (strokes.length > 0) return { strokeWeight: n.strokeWeight, strokes };
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

/**
 * Figma 노드명 + 타입으로 기대되는 HTML 태그를 추론
 */
function inferExpectedTag(name: string, nodeType: string): string | null {
  const lower = name.toLowerCase();
  const isComponent = nodeType === "COMPONENT" || nodeType === "INSTANCE" || nodeType === "COMPONENT_SET";

  if (isComponent) {
    if (/\b(button|btn|cta)\b/.test(lower)) return "button|a";
    if (/\blink\b/.test(lower)) return "a";
    if (/\b(input|textfield|text.?field)\b/.test(lower)) return "input|textarea";
    if (/\bcheckbox\b/.test(lower)) return "input";
    if (/\bradio\b/.test(lower)) return "input";
    if (/\b(select|dropdown|drop.?down)\b/.test(lower)) return "select|button";
    if (/\b(image|img|photo|thumbnail|thumb)\b/.test(lower)) return "img";
  }

  if (nodeType === "TEXT") return "p|span|h1|h2|h3|h4|h5|h6|label|li|a";
  return null;
}

function inferAnimationClassHints(name: string): string[] | null {
  const hints = ["fade-in", "btn-hover", "slide-up", "scale-in"].filter((k) => name.includes(k));
  return hints.length ? hints : null;
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 텍스트 노드의 fontWeight를 결정.
 */
function resolveFontWeight(n: any): number | null {
  const baseWeight = n.style?.fontWeight != null ? Number(n.style.fontWeight) : null;
  if (baseWeight == null) return null;

  const overrides: number[] = Array.isArray(n.characterStyleOverrides) ? n.characterStyleOverrides : [];
  const table: Record<string, any> = n.styleOverrideTable ?? {};

  if (overrides.length === 0) return baseWeight;

  const counts = new Map<number, number>();
  for (const idx of overrides) {
    const w = idx === 0 ? baseWeight : (table[String(idx)]?.fontWeight != null ? Number(table[String(idx)].fontWeight) : baseWeight);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  const totalChars = typeof n.characters === "string" ? n.characters.length : overrides.length;
  const noOverrideCount = Math.max(0, totalChars - overrides.length);
  if (noOverrideCount > 0) counts.set(baseWeight, (counts.get(baseWeight) ?? 0) + noOverrideCount);

  let maxCount = 0;
  let dominant = baseWeight;
  for (const [w, c] of counts) {
    if (c > maxCount) { maxCount = c; dominant = w; }
  }
  return dominant;
}
