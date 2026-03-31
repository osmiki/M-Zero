import { normalizeColorToHex, parseCssPx, roundPx } from "@/lib/normalize";
import type { CompareRow, DiffItem, FigmaChildTextNode, ShadowValue, WebTextChild } from "./types";

// ─────────────────────────────────────────────────────────
// Text matching helpers
// ─────────────────────────────────────────────────────────

/** 두 문자열의 토큰 집합 교집합 기반 유사도 (0~1) */
export function tokenSimilarity(a: string, b: string): number {
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
export function isVariableText(text: string): boolean {
  return /^[\d,.\s/\-:₩원%+]+$/.test(text.trim());
}

/**
 * Figma childTextNode 하나에 가장 잘 맞는 웹 텍스트 자식을 찾는다.
 * 점수 배분: 내용 일치 50 + 위치 유사도 30 + 스타일 근접도 20
 */
export function findBestWebChild(
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

// ─────────────────────────────────────────────────────────
// Push helpers (rows / diffs builders)
// ─────────────────────────────────────────────────────────

export function pushPx(
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
export function pushPxInfo(
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

export function pushExact(rows: CompareRow[], diffs: DiffItem[], key: string, figma: any, web: any) {
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

export function pushColor(
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

export function pushNumber(
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

export function toFloat(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number.parseFloat(String(s));
  return Number.isFinite(n) ? n : null;
}

export function toInt(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number.parseInt(String(s), 10);
  return Number.isFinite(n) ? n : null;
}

export function parseBorderRadiusPx(s: string | null | undefined): number | null {
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
export function pushPaddingOrMargin(
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
export function isFullyTransparent(hex: string | null | undefined): boolean {
  if (!hex) return false;
  // #rrggbbaa 형식: 마지막 2자리가 "00" 이면 alpha=0
  const m = hex.match(/^#[0-9a-f]{6}([0-9a-f]{2})$/i);
  if (m) return m[1].toLowerCase() === "00";
  return false;
}

export function parseLineHeightPx(lineHeight: string | null | undefined, fontSizePx: number | null): number | null {
  const px = parseCssPx(lineHeight);
  if (px != null) return px;
  if (!lineHeight) return null;
  const s = String(lineHeight).trim();
  if (!s) return null;
  // "normal" → 브라우저 기본값 ≈ fontSize × 1.2 (휴리스틱)
  if (s === "normal") return fontSizePx != null ? roundPx(fontSizePx * 1.2) : null;
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  if (fontSizePx != null) return roundPx(n * fontSizePx);
  return null;
}

export function shadowToStr(s: ShadowValue): string {
  return `${s.inset ? "inset " : ""}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${s.color}`;
}

/**
 * CSS box-shadow 문자열에서 첫 번째 섀도우 파싱
 * 예: "0px 2px 4px 0px rgba(0,0,0,0.15)" → { x:0, y:2, blur:4, spread:0, color:"...", inset:false }
 * "none" 또는 파싱 불가 → null
 */
export function parseCssBoxShadow(s: string | null | undefined): ShadowValue | null {
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

export function severityFromDiffs(diffs: DiffItem[], thresholdPx: number): "pass" | "warn" | "fail" {
  if (diffs.length === 0) return "pass";
  let hasWarn = false;
  for (const d of diffs) {
    if (d.key === "element") return "fail";
    // warnOnly 항목은 경고일 뿐 FAIL이 아님
    if (d.warnOnly) { hasWarn = true; continue; }
    if (typeof d.delta === "number" && Number.isFinite(d.delta)) {
      if (Math.abs(d.delta) > thresholdPx) return "fail";
    } else {
      // Non-numeric mismatch (color/fontWeight/animation class)
      return "fail";
    }
  }
  return hasWarn ? "warn" : "pass";
}
