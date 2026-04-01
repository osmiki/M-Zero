import type { FigmaToken } from "@/lib/figma";
import { normalizeColorToHex, parseCssPx, roundPx } from "@/lib/normalize";
import type { CompareConfig, CompareRow, ComputedPayload, DiffItem, WebTextChild } from "./types";
import {
  findBestWebChild,
  isFullyTransparent,
  parseBorderRadiusPx,
  parseCssBoxShadow,
  parseLineHeightPx,
  pushColor,
  pushExact,
  pushNumber,
  pushPaddingOrMargin,
  pushPx,
  pushPxInfo,
  severityFromDiffs,
  shadowToStr,
  toFloat,
  toInt,
} from "./helpers";

const APPLE_SYSTEM_FONTS = ["sf pro display", "sf pro text", "sf pro", "sf compact", "-apple-system", "blinkmacsystemfont"];

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
        colorToken:     token.figma.colorToken      ?? cf.colorToken,
        fontSize:       token.figma.fontSize        ?? cf.fontSize,
        fontWeight:     token.figma.fontWeight      ?? cf.fontWeight,
        fontFamily:     token.figma.fontFamily      ?? cf.fontFamily,
        lineHeightPx:   token.figma.lineHeightPx    ?? cf.lineHeightPx,
        letterSpacingPx:token.figma.letterSpacingPx ?? cf.letterSpacingPx,
        // strokeWidth/strokeColor는 루트 컴포넌트에 직접 있을 때만 비교.
        // childFoundation에서 상속하면 어느 자식 노드인지 추적 불가 → 제외
        strokeWidth:    token.figma.strokeWidth,
        strokeColor:    token.figma.strokeColor,
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
  // Spacing (Padding / Gap) — strict 모드(COMPONENT/INSTANCE)만 비교
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
  // display/flexDirection/alignItems/justifyContent → 구현 방법이므로 Design QA에서 제외

  // ── textAlign (항상 비교 — 눈에 보이는 결과) ──
  if (fig.textAlignHorizontal) {
    const textAlignMap: Record<string, string[]> = {
      "LEFT": ["left", "start"],
      "CENTER": ["center"],
      "RIGHT": ["right", "end"],
      "JUSTIFIED": ["justify"],
    };
    const expected = textAlignMap[fig.textAlignHorizontal];
    if (expected) {
      const webTextAlign = (web.textAlign ?? "start").toLowerCase();
      const ok = expected.includes(webTextAlign);
      rows.push({ key: "textAlign", figma: expected[0], web: webTextAlign, delta: null, ok });
      if (!ok) diffs.push({ key: "textAlign", figma: expected[0], web: webTextAlign, delta: null });
    }
  }

  // ── textTransform (항상 비교) ──
  if (fig.textCase && fig.textCase !== "ORIGINAL") {
    const caseMap: Record<string, string> = {
      "UPPER": "uppercase",
      "LOWER": "lowercase",
      "TITLE": "capitalize",
    };
    const expected = caseMap[fig.textCase];
    if (expected) {
      const webTransform = (web.textTransform ?? "none").toLowerCase();
      const ok = webTransform === expected;
      rows.push({ key: "textTransform", figma: expected, web: webTransform, delta: null, ok });
      if (!ok) diffs.push({ key: "textTransform", figma: expected, web: webTransform, delta: null });
    }
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
