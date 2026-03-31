import type { FigmaToken } from "@/lib/figma";

// ─────────────────────────────────────────────────────────
// Scoring: Figma childTextNode ↔ 웹 텍스트 자식 최적 매칭
// ─────────────────────────────────────────────────────────
export type WebTextChild = {
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

export type FigmaChildTextNode = NonNullable<FigmaToken["childTextNodes"]>[number];

export type CompareConfig = {
  thresholdPx: number;
  /**
   * strict      : COMPONENT / INSTANCE 노드 — 모든 속성 엄격 비교 (Critical Fail)
   * foundational: FRAME / GROUP 등 일반 레이어 — Foundation 값(색상·폰트·radius)만 비교
   */
  compareMode?: "strict" | "foundational";
};

export type ComputedPayload = { classList: string[]; computed: Record<string, string> } | null;

export type DiffItem = {
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

export type ShadowValue = { x: number; y: number; blur: number; spread: number; color: string; inset: boolean };
