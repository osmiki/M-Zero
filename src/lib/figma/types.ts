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
  /** TEXT 노드의 텍스트 내용 (텍스트 매칭에 사용) */
  characters?: string | null;
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
    // Layout properties (Phase 2)
    /** "HORIZONTAL" | "VERTICAL" | "NONE" — auto-layout 방향 */
    layoutMode?: string | null;
    /** "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN" — 주축 정렬 */
    primaryAxisAlignItems?: string | null;
    /** "MIN" | "CENTER" | "MAX" | "BASELINE" — 교차축 정렬 */
    counterAxisAlignItems?: string | null;
    /** "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED" — 텍스트 수평 정렬 */
    textAlignHorizontal?: string | null;
    /** "ORIGINAL" | "UPPER" | "LOWER" | "TITLE" — 텍스트 변환 */
    textCase?: string | null;
  };
};
