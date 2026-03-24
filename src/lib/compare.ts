import type { FigmaToken } from "@/lib/figma";
import { normalizeColorToHex, parseCssPx, roundPx } from "@/lib/normalize";

// ─────────────────────────────────────────────────────────
// Scoring: Figma childTextNode ↔ 웹 텍스트 자식 최적 매칭
// ─────────────────────────────────────────────────────────
type WebTextChild = {
  text: string;
  index: number;
  fontSize: string;
  fontWeight: string;
  fontFamily: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
  classList: string[];
};

type FigmaChildTextNode = NonNullable<FigmaToken["childTextNodes"]>[number];

/** 두 문자열의 토큰 집합 교집합 기반 유사도 (0~1) */
function tokenSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s,₩원%]/g, "");
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // 짧은 쪽이 긴 쪽에 포함되면 부분 일치
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  // 공통 문자 비율
  const setA = new Set(na.split(""));
  const setB = new Set(nb.split(""));
  let common = 0;
  for (const c of setA) if (setB.has(c)) common++;
  return common / Math.max(setA.size, setB.size);
}

/** 텍스트가 숫자/날짜/가격처럼 가변적인 값인지 판별 */
function isVariableText(text: string): boolean {
  return /^[\d,.\s/\-:₩원%+]+$/.test(text.trim());
}

/**
 * Figma childTextNode 하나에 가장 잘 맞는 웹 텍스트 자식을 찾는다.
 * 점수 배분: 내용 일치 50 + 위치 유사도 30 + 스타일 근접도 20
 */
function findBestWebChild(
  figChild: FigmaChildTextNode,
  webChildren: WebTextChild[],
  totalFigChildren: number
): WebTextChild | null {
  if (webChildren.length === 0) return null;
  if (webChildren.length === 1) return webChildren[0];

  let bestScore = -1;
  let best: WebTextChild | null = null;

  for (const wc of webChildren) {
    let score = 0;

    // 1. 내용 일치 (0~50점)
    const isVariable = isVariableText(figChild.characters);
    if (!isVariable && figChild.characters) {
      const sim = tokenSimilarity(figChild.characters, wc.text);
      score += sim >= 0.8 ? 50 : sim * 40;
    }

    // Step 3: 가변 텍스트면 노드 이름 키워드 vs 웹 클래스명 매칭 (0~30점)
    if (isVariable || score < 20) {
      const nameKeywords = figChild.name.toLowerCase().split(/[_\-\s]+/).filter(k => k.length > 1);
      const classStr = wc.classList.join(" ").toLowerCase();
      const textStr = wc.text.toLowerCase();
      const keywordHit = nameKeywords.some(k => classStr.includes(k) || textStr.includes(k));
      if (keywordHit) score += 30;
    }

    // 2. 위치 유사도 (0~30점)
    const figRelPos = totalFigChildren > 1 ? figChild.index / (totalFigChildren - 1) : 0;
    const webRelPos = webChildren.length > 1 ? wc.index / (webChildren.length - 1) : 0;
    score += (1 - Math.abs(figRelPos - webRelPos)) * 30;

    // 3. 스타일 근접도 — fontSize (0~20점, 가변 텍스트일 때 주요 신호)
    if (figChild.fontSize != null) {
      const webFs = parseFloat(wc.fontSize);
      if (!isNaN(webFs) && figChild.fontSize > 0) {
        const diff = Math.abs(figChild.fontSize - webFs) / figChild.fontSize;
        score += (1 - Math.min(diff, 1)) * 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      best = wc;
    }
  }

  return best;
}

export type CompareConfig = {
  thresholdPx: number;
  /**
   * strict      : COMPONENT / INSTANCE 노드 — 모든 속성 엄격 비교 (Critical Fail)
   * foundational: FRAME / GROUP 등 일반 레이어 — Foundation 값(색상·폰트·radius)만 비교
   */
  compareMode?: "strict" | "foundational";
};

type ComputedPayload = { classList: string[]; computed: Record<string, string> } | null;

type DiffItem = {
  key: string;
  figma?: string | number | null;
  web?: string | number | null;
  delta?: number | null;
  warnOnly?: boolean; // true면 FAIL이 아닌 WARN으로 분류
  /** 색상 chip 표시용 hex (#rrggbbaa). figma/web가 토큰명일 때도 원본 hex 보존 */
  figmaHex?: string | null;
  webHex?: string | null;
  /** hex는 같으나 사용한 토큰(CSS 변수 / Named Style)이 달라 WARN인 경우 */
  tokenMismatch?: boolean;
};

export type CompareRow = {
  key: string;
  figma?: string | number | null;
  web?: string | number | null;
  delta?: number | null;
  ok: boolean;
  figmaHex?: string | null;
  webHex?: string | null;
  tokenMismatch?: boolean;
};

export function compareTokenToComputed(
  token: FigmaToken,
  computedPayload: ComputedPayload,
  cfg: CompareConfig
): { severity: "pass" | "warn" | "fail"; compareMode: "strict" | "foundational"; diffs: DiffItem[]; rows: CompareRow[] } {
  const diffs: DiffItem[] = [];
  const rows: CompareRow[] = [];
  const compareMode = cfg.compareMode ?? "strict";
  const isFoundational = compareMode === "foundational";

  if (!computedPayload) {
    diffs.push({ key: "element", figma: "expected", web: "not found", delta: null });
    rows.push({ key: "element", figma: "expected", web: "not found", delta: null, ok: false });
    return { severity: "fail", compareMode, diffs, rows };
  }

  // childFoundation: COMPONENT/INSTANCE 내부 자식에서 수집한 값을
  // token.figma의 null 항목에 머지 (2순위 Foundation — 브랜드 가이드 위반 감지)
  const cf = token.childFoundation;
  const fig: typeof token.figma = cf
    ? {
        ...token.figma,
        color:          token.figma.color          ?? cf.color,
        fontSize:       token.figma.fontSize        ?? cf.fontSize,
        fontWeight:     token.figma.fontWeight      ?? cf.fontWeight,
        fontFamily:     token.figma.fontFamily      ?? cf.fontFamily,
        lineHeightPx:   token.figma.lineHeightPx    ?? cf.lineHeightPx,
        letterSpacingPx:token.figma.letterSpacingPx ?? cf.letterSpacingPx,
        strokeWidth:    token.figma.strokeWidth     ?? cf.strokeWidth,
        strokeColor:    token.figma.strokeColor     ?? cf.strokeColor,
        shadow:         token.figma.shadow          ?? cf.shadow,
      }
    : token.figma;
  const web = computedPayload.computed;

  // ─────────────────────────────────────────────────────────
  // Layout: width/height → 항상 info 행 (severity 영향 없음)
  // ─────────────────────────────────────────────────────────
  pushPxInfo(rows, "width",  fig.width,  parseCssPx(web.width));
  pushPxInfo(rows, "height", fig.height, parseCssPx(web.height));

  // ─────────────────────────────────────────────────────────
  // [Strict 전용] Spacing (Padding / Gap)
  // Foundational 모드에서는 레이아웃 수치 검증 제외
  // ─────────────────────────────────────────────────────────
  if (!isFoundational) {
    if (fig.padding) {
      pushPaddingOrMargin(rows, diffs, "paddingTop",    fig.padding.top,    parseCssPx(web.paddingTop),    parseCssPx(web.marginTop),    cfg.thresholdPx);
      pushPaddingOrMargin(rows, diffs, "paddingRight",  fig.padding.right,  parseCssPx(web.paddingRight),  parseCssPx(web.marginRight),  cfg.thresholdPx);
      pushPaddingOrMargin(rows, diffs, "paddingBottom", fig.padding.bottom, parseCssPx(web.paddingBottom), parseCssPx(web.marginBottom), cfg.thresholdPx);
      pushPaddingOrMargin(rows, diffs, "paddingLeft",   fig.padding.left,   parseCssPx(web.paddingLeft),   parseCssPx(web.marginLeft),   cfg.thresholdPx);
    }
    pushPx(rows, diffs, "gap", fig.itemSpacing, parseCssPx(web.gap), cfg.thresholdPx);
  }

  // ─────────────────────────────────────────────────────────
  // Typography: 항상 비교 (Foundation 값)
  // childTextNodes가 있으면 Scoring 알고리즘으로 최적 웹 자식을 찾아 비교.
  // 없으면 기존 첫 번째 자식(_textChild*) 또는 컨테이너 값 사용.
  // ─────────────────────────────────────────────────────────
  const cfExists = cf != null;
  const childTextNodes = token.childTextNodes ?? null;

  // Figma childTextNodes에서 font값을 가져오는 속성별로 "최적 웹 자식" 결정
  // childFoundation 값이 cf에서 채워진 경우(token.figma.* == null)에만 자식 기준 비교
  const usingCfFontSize      = cfExists && token.figma.fontSize       == null && cf!.fontSize       != null;
  const usingCfFontWeight    = cfExists && token.figma.fontWeight     == null && cf!.fontWeight     != null;
  const usingCfLineHeight    = cfExists && token.figma.lineHeightPx   == null && cf!.lineHeightPx   != null;
  const usingCfLetterSpacing = cfExists && token.figma.letterSpacingPx == null && cf!.letterSpacingPx != null;
  const usingCfFontFamily    = cfExists && token.figma.fontFamily     == null && cf!.fontFamily     != null;
  const anyUsingCf = usingCfFontSize || usingCfFontWeight || usingCfLineHeight || usingCfLetterSpacing || usingCfFontFamily;

  // _textChildren (JSON) → WebTextChild[]
  let webTextChildren: WebTextChild[] = [];
  if (web._textChildren) {
    try { webTextChildren = JSON.parse(web._textChildren); } catch { /* ignore */ }
  }

  // Scoring으로 최적 웹 자식 선택 (childTextNodes가 있고 cf 기반 비교가 필요한 경우)
  // cf의 대표 TEXT 노드 = childTextNodes 중 cf 값과 일치하는 첫 번째 노드
  let bestWebChild: WebTextChild | null = null;
  if (anyUsingCf && webTextChildren.length > 0) {
    if (childTextNodes && childTextNodes.length > 0) {
      // cf 값과 일치하는 Figma TEXT 노드를 대표로 선택 (fontSize 기준)
      const cfFigNode = childTextNodes.find(n => n.fontSize === cf!.fontSize && n.fontWeight === cf!.fontWeight)
        ?? childTextNodes[0];
      bestWebChild = findBestWebChild(cfFigNode, webTextChildren, childTextNodes.length);
    } else {
      // childTextNodes 없으면 첫 번째 웹 자식 사용 (기존 방식)
      bestWebChild = webTextChildren[0] ?? null;
    }
  }

  // 웹 값 결정: 최적 자식이 있으면 그 값, 없으면 컨테이너 값
  const webFontSizePx = parseCssPx(
    usingCfFontSize ? (bestWebChild?.fontSize ?? web._textChildFontSize ?? web.fontSize) : web.fontSize
  );
  const webFontWeightRaw = usingCfFontWeight
    ? (bestWebChild?.fontWeight ?? web._textChildFontWeight ?? web.fontWeight)
    : web.fontWeight;
  const webLineHeightRaw = usingCfLineHeight
    ? (bestWebChild?.lineHeight ?? web._textChildLineHeight ?? web.lineHeight)
    : web.lineHeight;
  const webLetterSpacingRaw = usingCfLetterSpacing
    ? (bestWebChild?.letterSpacing ?? web._textChildLetterSpacing ?? web.letterSpacing)
    : web.letterSpacing;

  pushPx(rows, diffs, "fontSize", fig.fontSize, webFontSizePx, cfg.thresholdPx);

  // fontWeight: cf 기반이면 WARN 전용 (Scoring이 잘못된 자식을 선택할 여지가 있음)
  if (usingCfFontWeight) {
    if (fig.fontWeight != null && toInt(webFontWeightRaw) != null) {
      const ok = String(fig.fontWeight) === String(toInt(webFontWeightRaw));
      rows.push({ key: "fontWeight", figma: fig.fontWeight, web: toInt(webFontWeightRaw), delta: null, ok });
      if (!ok) diffs.push({ key: "fontWeight", figma: fig.fontWeight, web: toInt(webFontWeightRaw), delta: null, warnOnly: true });
    }
  } else {
    pushExact(rows, diffs, "fontWeight", fig.fontWeight, toInt(webFontWeightRaw));
  }
  pushPx(rows, diffs, "lineHeight", fig.lineHeightPx, parseLineHeightPx(webLineHeightRaw, webFontSizePx), cfg.thresholdPx);
  pushPx(rows, diffs, "letterSpacing", fig.letterSpacingPx, parseCssPx(webLetterSpacingRaw), cfg.thresholdPx);

  // fontFamily: Figma 폰트가 web font-family 스택에 포함되는지 확인
  // Apple 시스템 폰트(SF Pro 계열 등)는 Mac 디자이너가 의도치 않게 사용하는 경우가 많아
  // 웹에서 Pretendard 등 다른 폰트를 써도 FAIL로 잡지 않음 (SKIP)
  const APPLE_SYSTEM_FONTS = ["sf pro display", "sf pro text", "sf pro", "sf compact", "-apple-system", "blinkmacsystemfont"];
  if (fig.fontFamily) {
    const webFamilyRaw = usingCfFontFamily
      ? (bestWebChild?.fontFamily ?? web._textChildFontFamily ?? web.fontFamily ?? "")
      : (web.fontFamily ?? "");
    // CSS font-family는 "Pretendard, -apple-system, sans-serif" 형태 — 첫 번째 값 또는 전체에서 탐색
    const figFamilyNorm = fig.fontFamily.toLowerCase().replace(/['"]/g, "").trim();
    const webFamilyNorm = webFamilyRaw.toLowerCase().replace(/['"]/g, "");
    // Apple 시스템 폰트면 비교 스킵
    const isAppleSystemFont = APPLE_SYSTEM_FONTS.some(f => figFamilyNorm.startsWith(f));
    if (!isAppleSystemFont) {
      const match = webFamilyNorm.includes(figFamilyNorm);
      if (!match) {
        const webFirst = webFamilyNorm.split(",")[0].trim();
        diffs.push({ key: "fontFamily", figma: fig.fontFamily, web: webFirst || webFamilyRaw || "none", delta: null });
        rows.push({ key: "fontFamily", figma: fig.fontFamily, web: webFirst || webFamilyRaw || "none", delta: null, ok: false });
      }
    }
  }

  // fontStyle (italic)
  if (fig.fontStyle) {
    const webFontStyle = (web.fontStyle ?? "normal").toLowerCase();
    const figFontStyle = fig.fontStyle.toLowerCase();
    if (webFontStyle !== figFontStyle) {
      diffs.push({ key: "fontStyle", figma: fig.fontStyle, web: webFontStyle, delta: null });
      rows.push({ key: "fontStyle", figma: fig.fontStyle, web: webFontStyle, delta: null, ok: false });
    }
  }

  // textDecoration (underline, line-through 등)
  if (fig.textDecoration) {
    const webDeco = (web.textDecoration ?? "none").toLowerCase().split(" ")[0];
    const figDeco = fig.textDecoration.toLowerCase();
    if (webDeco !== figDeco) {
      diffs.push({ key: "textDecoration", figma: fig.textDecoration, web: webDeco || "none", delta: null });
      rows.push({ key: "textDecoration", figma: fig.textDecoration, web: webDeco || "none", delta: null, ok: false });
    }
  }

  // ─────────────────────────────────────────────────────────
  // Color: 항상 비교 (Foundation 값)
  // Figma Named Style 토큰명과 웹 CSS 변수명을 정규화 비교:
  //   hex 동일 + 토큰 다름 → WARN (디자인 시스템 불일치)
  //   hex 다름              → FAIL
  // ─────────────────────────────────────────────────────────
  const webColorStr = (fig.color != null && web._textChildColor) ? web._textChildColor : web.color;
  pushColor(rows, diffs, "color", fig.color, normalizeColorToHex(webColorStr),
    fig.colorToken ?? null, web._colorVar ?? null);

  const webBgHex = normalizeColorToHex(web.backgroundColor);
  const figHasBg = fig.backgroundColor != null && !isFullyTransparent(normalizeColorToHex(fig.backgroundColor));
  if (figHasBg || !isFullyTransparent(webBgHex)) {
    pushColor(rows, diffs, "backgroundColor", fig.backgroundColor, webBgHex,
      fig.backgroundColorToken ?? null, web._backgroundColorVar ?? null);
  }

  // ─────────────────────────────────────────────────────────
  // Stroke (border / outline)
  // Figma에 stroke가 정의돼 있으면 노드 타입 관계없이 항상 비교
  // (Strict 전용이었으나 FRAME/GROUP도 stroke를 가질 수 있음)
  // ─────────────────────────────────────────────────────────
  const figHasStroke = fig.strokeWidth != null || !!fig.strokeColor;
  if (!isFoundational || figHasStroke) {
    const sides = ["Top", "Right", "Bottom", "Left"] as const;
    const borderWs = sides.map((s) => parseCssPx((web as any)[`border${s}Width`]) ?? 0);
    const maxBorderW = Math.max(...borderWs);
    const outlineW = parseCssPx(web.outlineWidth) ?? 0;
    const effectiveW = maxBorderW > 0 ? maxBorderW : outlineW > 0 ? outlineW : 0;

    if (fig.strokeWidth != null) {
      pushPx(rows, diffs, "strokeWidth", fig.strokeWidth, effectiveW || null, cfg.thresholdPx);
    } else if (effectiveW > 0) {
      rows.push({ key: "strokeWidth ⚠", figma: null, web: effectiveW, delta: null, ok: false });
      diffs.push({ key: "strokeWidth", figma: null, web: effectiveW, delta: null, warnOnly: true });
    }

    if (fig.strokeColor) {
      const outlineW2 = parseCssPx(web.outlineWidth) ?? 0;
      const outlineStyle = web.outlineStyle;
      let bestBorderW = 0;
      let bestBorderColor: string | null = null;
      for (const s of sides) {
        const w = parseCssPx((web as any)[`border${s}Width`]) ?? 0;
        if (w > bestBorderW) { bestBorderW = w; bestBorderColor = (web as any)[`border${s}Color`] ?? null; }
      }
      const useOutline = bestBorderW === 0 && outlineW2 > 0 && outlineStyle !== "none";
      const webStrokeHex = normalizeColorToHex(useOutline ? web.outlineColor : bestBorderColor);
      const hasNoBorder = bestBorderW === 0 && outlineW2 === 0;
      if (!hasNoBorder) {
        pushColor(rows, diffs, "strokeColor", fig.strokeColor, webStrokeHex);
      } else {
        diffs.push({ key: "strokeColor", figma: fig.strokeColor, web: "none", delta: null });
        rows.push({ key: "strokeColor", figma: fig.strokeColor, web: "none", delta: null, ok: false });
      }
    }
  }

  // ─────────────────────────────────────────────────────────
  // Border-radius / Opacity: 항상 비교 (Foundation 값)
  // ─────────────────────────────────────────────────────────
  pushPx(rows, diffs, "borderRadius", fig.cornerRadius, parseBorderRadiusPx(web.borderRadius), cfg.thresholdPx);
  if (fig.opacity != null) {
    pushNumber(rows, diffs, "opacity", fig.opacity, toFloat(web.opacity), 0.02);
  }

  // ─────────────────────────────────────────────────────────
  // [Strict 전용] Shadow / Animation / TagName
  // ─────────────────────────────────────────────────────────
  if (!isFoundational) {
    if (fig.shadow != null) {
      const webShadow = parseCssBoxShadow(web.boxShadow);
      if (webShadow == null) {
        rows.push({ key: "shadow", figma: shadowToStr(fig.shadow), web: "none", delta: null, ok: false });
        diffs.push({ key: "shadow", figma: shadowToStr(fig.shadow), web: "none", delta: null });
      } else {
        const xDelta = roundPx(webShadow.x - fig.shadow.x);
        const yDelta = roundPx(webShadow.y - fig.shadow.y);
        const blurDelta = roundPx(webShadow.blur - fig.shadow.blur);
        const spreadDelta = roundPx(webShadow.spread - fig.shadow.spread);
        const maxDelta = Math.max(Math.abs(xDelta), Math.abs(yDelta), Math.abs(blurDelta), Math.abs(spreadDelta));
        const colorOk = fig.shadow.color.toLowerCase() === (webShadow.color ?? "").toLowerCase();
        const insetOk = fig.shadow.inset === webShadow.inset;
        const ok = maxDelta <= cfg.thresholdPx && colorOk && insetOk;
        rows.push({ key: "shadow", figma: shadowToStr(fig.shadow), web: shadowToStr(webShadow), delta: maxDelta || null, ok });
        if (!ok) diffs.push({ key: "shadow", figma: shadowToStr(fig.shadow), web: shadowToStr(webShadow), delta: maxDelta || null });
      }
    }

    if (fig.animationClassHints?.length) {
      for (const cls of fig.animationClassHints) {
        const ok = computedPayload.classList.includes(cls);
        if (!ok) {
          diffs.push({ key: "animationClass", figma: cls, web: "(missing)", delta: null });
          rows.push({ key: `animationClass:${cls}`, figma: cls, web: "(missing)", delta: null, ok: false });
        } else {
          rows.push({ key: `animationClass:${cls}`, figma: cls, web: "(present)", delta: null, ok: true });
        }
      }
    }

    if (fig.expectedTag) {
      const webTag = web._tagName ?? "";
      const allowed = fig.expectedTag.split("|");
      const ok = webTag ? allowed.includes(webTag) : false;
      rows.push({ key: "tagName", figma: fig.expectedTag, web: webTag || "(unknown)", delta: null, ok });
      if (!ok) diffs.push({ key: "tagName", figma: fig.expectedTag, web: webTag || "(unknown)", delta: null, warnOnly: true });
    }
  }

  const severity = severityFromDiffs(diffs, cfg.thresholdPx);
  return { severity, compareMode, diffs, rows };
}

function severityFromDiffs(diffs: DiffItem[], thresholdPx: number): "pass" | "warn" | "fail" {
  if (diffs.length === 0) return "pass";
  let hasFail = false;
  let hasWarn = false;
  for (const d of diffs) {
    if (d.key === "element") return "fail";
    if (d.warnOnly) { hasWarn = true; continue; }
    if (typeof d.delta === "number" && Number.isFinite(d.delta)) {
      const abs = Math.abs(d.delta);
      if (abs <= thresholdPx) hasWarn = true;
      else hasFail = true;
    } else {
      // Non-numeric mismatch (color/fontWeight/animation class)
      hasFail = true;
    }
  }
  if (hasFail) return "fail";
  if (hasWarn) return "warn";
  return "pass";
}

function pushPx(
  rows: CompareRow[],
  diffs: DiffItem[],
  key: string,
  figma: number | null | undefined,
  web: number | null,
  thresholdPx: number
) {
  if (figma == null || web == null) return;
  const delta = roundPx(web - figma);
  // ok = threshold 이내면 "허용 범위" → UI에서 초록으로 표시
  const ok = Math.abs(delta) <= thresholdPx;
  rows.push({ key, figma: roundPx(figma), web: roundPx(web), delta, ok });
  if (delta === 0) return;           // 완전 일치: diffs에 추가 안 함
  diffs.push({ key, figma: roundPx(figma), web: roundPx(web), delta });
  // severity: severityFromDiffs에서 thresholdPx 기준으로 WARN/FAIL 결정
}

/** width/height: 값은 보여주되 severity에 영향 없는 info 행 */
function pushPxInfo(
  rows: CompareRow[],
  key: string,
  figma: number | null | undefined,
  web: number | null
) {
  if (figma == null || web == null) return;
  const delta = roundPx(web - figma);
  // ok=true 고정 → diffs에 추가 안 함 → severity 영향 없음
  rows.push({ key: `${key} ℹ`, figma: roundPx(figma), web: roundPx(web), delta, ok: true });
}

function pushExact(rows: CompareRow[], diffs: DiffItem[], key: string, figma: any, web: any) {
  if (figma == null || web == null) return;
  const ok = String(figma) === String(web);
  rows.push({ key, figma, web, delta: null, ok });
  if (ok) return;
  diffs.push({ key, figma, web, delta: null });
}

/** #rrggbbaa → { r,g,b,a } (0~255, a: 0~1) */
function parseHex8(hex: string): { r: number; g: number; b: number; a: number } | null {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
  if (!m) return null;
  return {
    r: parseInt(m[1], 16),
    g: parseInt(m[2], 16),
    b: parseInt(m[3], 16),
    a: m[4] ? parseInt(m[4], 16) / 255 : 1,
  };
}

/** alpha가 있는 색상을 흰 배경 위에 합성 */
function compositeOverWhite(c: { r: number; g: number; b: number; a: number }) {
  return {
    r: Math.round(c.r * c.a + 255 * (1 - c.a)),
    g: Math.round(c.g * c.a + 255 * (1 - c.a)),
    b: Math.round(c.b * c.a + 255 * (1 - c.a)),
  };
}

/** 두 RGB 채널의 최대 차이 (0~255) */
function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number }
) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
}

/**
 * Figma Named Style 이름("Gray 900") 또는 CSS 변수명("--gray-900")을
 * 정규화해 토큰 레벨 비교에 사용.
 * "Colors/Gray 900" → "gray-900"
 * "--color-gray-900" → "color-gray-900"
 */
function normalizeTokenName(name: string): string {
  return name
    .replace(/^--/, "")                    // CSS var prefix 제거
    .split("/").pop()!                     // "Colors/Gray 900" → "Gray 900"
    .toLowerCase()
    .replace(/\s+/g, "-")                  // 공백 → 하이픈
    .replace(/[^a-z0-9-]/g, "");           // 특수문자 제거
}

function pushColor(
  rows: CompareRow[],
  diffs: DiffItem[],
  key: string,
  figmaHex: string | null | undefined,
  webHex: string | null,
  /** Figma Named Style 토큰명 (예: "Gray 900") */
  figmaToken?: string | null,
  /** 웹 CSS 변수명 (예: "--gray-900") */
  webToken?: string | null,
) {
  if (!figmaHex || !webHex) return;

  // ① 표시용 레이블: 토큰명이 있으면 우선, 없으면 hex
  const figmaDisplay = figmaToken ?? figmaHex;
  const webDisplay   = webToken   ?? webHex;

  // ② 토큰 정규화 비교 (둘 다 있을 때만)
  const normFigma = figmaToken ? normalizeTokenName(figmaToken) : null;
  const normWeb   = webToken   ? normalizeTokenName(webToken)   : null;
  const tokenMismatch = !!(normFigma && normWeb && normFigma !== normWeb);

  // ③ 헥스 색상 거리 비교
  const fParsed = parseHex8(figmaHex);
  const wParsed = parseHex8(webHex);
  let hexMatch = figmaHex.toLowerCase() === webHex.toLowerCase();
  if (!hexMatch && fParsed && wParsed) {
    const dist = colorDistance(compositeOverWhite(fParsed), compositeOverWhite(wParsed));
    hexMatch = dist <= 10;
  }

  const hexFields = { figmaHex: figmaHex ?? null, webHex: webHex ?? null };

  // ④ 판정 매트릭스
  if (hexMatch && !tokenMismatch) {
    rows.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, ok: true, ...hexFields });
    return;
  }

  if (hexMatch && tokenMismatch) {
    // hex는 같지만 다른 토큰 사용 → 디자인 시스템 불일치 → WARN
    rows.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, ok: false, tokenMismatch: true, ...hexFields });
    diffs.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, warnOnly: true, tokenMismatch: true, ...hexFields });
    return;
  }

  if (!hexMatch && fParsed && wParsed) {
    const bothOpaque = fParsed.a >= 254 / 255 && wParsed.a >= 254 / 255;
    const dist = colorDistance(compositeOverWhite(fParsed), compositeOverWhite(wParsed));
    if (!bothOpaque && dist <= 30) {
      rows.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, ok: false, ...hexFields });
      diffs.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, warnOnly: true, ...hexFields });
      return;
    }
  }

  rows.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, ok: false, ...hexFields });
  diffs.push({ key, figma: figmaDisplay, web: webDisplay, delta: null, ...hexFields });
}

function pushNumber(
  rows: CompareRow[],
  diffs: DiffItem[],
  key: string,
  figma: number | null | undefined,
  web: number | null,
  eps: number
) {
  if (figma == null || web == null) return;
  const delta = web - figma;
  const ok = Math.abs(delta) <= eps;
  rows.push({ key, figma: roundPx(figma), web: roundPx(web), delta: roundPx(delta), ok });
  if (ok) return;
  diffs.push({ key, figma: roundPx(figma), web: roundPx(web), delta: roundPx(delta) });
}

function toFloat(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number.parseFloat(String(s));
  return Number.isFinite(n) ? n : null;
}

function toInt(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

function parseBorderRadiusPx(s: string | null | undefined): number | null {
  if (!s) return null;
  const first = String(s).trim().split(/\s+/)[0];
  return parseCssPx(first);
}

/**
 * Figma padding vs CSS 유효 여백 비교
 * CSS에서 동일한 시각적 여백이 padding 또는 margin으로 구현될 수 있으므로
 * 두 가지를 모두 확인:
 *   1) webPadding 단독으로 Figma padding과 일치하면 PASS
 *   2) webPadding + webMargin 합산이 Figma padding과 일치해도 PASS
 *   → 둘 다 불일치할 때만 FAIL
 */
function pushPaddingOrMargin(
  rows: CompareRow[],
  diffs: DiffItem[],
  key: string,
  figma: number | null | undefined,
  webPadding: number | null,
  webMargin: number | null,
  thresholdPx: number
) {
  if (figma == null) return;
  if (webPadding == null && webMargin == null) return;

  const pad = webPadding ?? 0;
  const mar = webMargin ?? 0;
  const effective = pad + mar; // CSS 유효 여백: padding + margin 합산

  const deltaFromPad = roundPx(pad - figma);
  const deltaFromEffective = roundPx(effective - figma);

  // 어느 쪽이든 threshold 이내면 PASS
  const okByPad       = Math.abs(deltaFromPad)       <= thresholdPx;
  const okByEffective = Math.abs(deltaFromEffective) <= thresholdPx;

  if (okByPad || okByEffective) {
    // PASS: rows에만 기록, diffs에 추가 안 함
    const bestDelta = okByPad ? deltaFromPad : deltaFromEffective;
    const displayWeb = okByPad ? roundPx(pad) : roundPx(effective);
    const label = (!okByPad && mar !== 0) ? `${key} (pad+margin)` : key;
    rows.push({ key: label, figma: roundPx(figma), web: displayWeb, delta: bestDelta, ok: true });
    return;
  }

  // FAIL: 가장 근접한 값(effective)으로 표시
  const displayWeb = roundPx(effective);
  const delta = deltaFromEffective;
  rows.push({ key, figma: roundPx(figma), web: displayWeb, delta, ok: false });
  diffs.push({ key, figma: roundPx(figma), web: displayWeb, delta });
}

/** alpha 채널이 0인 색상(= CSS transparent / 배경색 미설정)인지 확인 */
function isFullyTransparent(hex: string | null | undefined): boolean {
  if (!hex) return false;
  // #rrggbbaa 형식: 마지막 2자리가 "00" 이면 alpha=0
  const m = hex.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i);
  if (m) return m[1].toLowerCase() === "00";
  return false;
}

function parseLineHeightPx(lineHeight: string | null | undefined, fontSizePx: number | null): number | null {
  const px = parseCssPx(lineHeight);
  if (px != null) return px;
  if (!lineHeight) return null;
  const s = String(lineHeight).trim();
  if (!s || s === "normal") return null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (fontSizePx != null) return roundPx(n * fontSizePx);
  return null;
}

type ShadowValue = { x: number; y: number; blur: number; spread: number; color: string; inset: boolean };

function shadowToStr(s: ShadowValue): string {
  return `${s.inset ? "inset " : ""}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`;
}

/**
 * CSS box-shadow 문자열에서 첫 번째 섀도우 파싱
 * 예: "0px 2px 4px 0px rgba(0,0,0,0.15)" → { x:0, y:2, blur:4, spread:0, color:"...", inset:false }
 * "none" 또는 파싱 불가 → null
 */
function parseCssBoxShadow(s: string | null | undefined): ShadowValue | null {
  if (!s || s.trim() === "none") return null;
  const str = s.trim();
  const inset = str.startsWith("inset ");
  const rest = inset ? str.slice(6).trim() : str;

  // 색상 부분(rgb/rgba/hex/#)을 임시 치환해 숫자 파싱
  const colorMatch = rest.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i);
  const color = colorMatch ? normalizeColorToHex(colorMatch[0]) ?? colorMatch[0] : null;
  const noColor = rest.replace(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/gi, "").trim();

  const nums = noColor.split(/\s+/).map((t) => parseCssPx(t)).filter((v): v is number => v != null);
  if (nums.length < 2) return null;

  return {
    x: nums[0] ?? 0,
    y: nums[1] ?? 0,
    blur: nums[2] ?? 0,
    spread: nums[3] ?? 0,
    color: color ?? "#000000ff",
    inset,
  };
}

