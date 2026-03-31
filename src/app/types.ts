export type ViewportPreset = "320" | "375" | "390" | "430" | "580" | "716" | "768" | "1024";

export type Severity = "pass" | "warn" | "fail";
export type CompareMode = "strict" | "foundational";

export type DiffItem = {
  key: string;
  figma?: string | number | null;
  web?: string | number | null;
  delta?: number | null;
  figmaHex?: string | null;
  webHex?: string | null;
  tokenMismatch?: boolean;
};

export type MatchMethod = "mapping" | "name-exact" | "name-normalized" | "iou" | "text" | null;

export type MatchResult = {
  className: string;
  selector: string;
  matchedWebClassName?: string | null;
  severity: Severity;
  compareMode: CompareMode;
  /** 매칭 방법 */
  matchMethod?: MatchMethod;
  /** 매칭 신뢰도 (0~1) */
  matchScore?: number | null;
  diffs: DiffItem[];
  rows: Array<{
    key: string;
    figma?: string | number | null;
    web?: string | number | null;
    delta?: number | null;
    ok: boolean;
    figmaHex?: string | null;
    webHex?: string | null;
    tokenMismatch?: boolean;
  }>;
  bbox?: { x: number; y: number; width: number; height: number } | null;
  textBbox?: { x: number; y: number; width: number; height: number } | null;
  fixedPosition?: "top" | "bottom" | null;
  elementFound: boolean;
};

export type CompareResponse =
  | {
      ok: true;
      summary: {
        total: number; pass: number; warn: number; fail: number; missing: number;
        strictFail: number;
        foundationalFail: number;
      };
      results: MatchResult[];
      meta: {
        web: {
          href: string; extractedAt: number;
          viewport: { width: number; height: number; devicePixelRatio: number };
          scrollHeight?: number; scrollY?: number; webDataId: string;
        };
        figma: { fileKey: string; nodeId: string };
        thresholdPx: number;
      };
    }
  | { ok: false; error: string };

export const VIEWPORT_GROUPS = [
  {
    label: "\ud83d\udcf1 Mobile \u2014 Small (320~375px)",
    desc: "iPhone SE \u00b7 iPhone 6~8 \u00b7 Galaxy S7~8 \u00b7 Galaxy Fold Cover",
    options: [
      { value: "320" as const, label: "320px \u00b7 iPhone SE (1\uc138\ub300)" },
      { value: "375" as const, label: "375px \u00b7 iPhone 6~8 / SE2~3 \u00b7 Galaxy S7~8" },
    ],
  },
  {
    label: "\ud83d\udcf1 Mobile \u2014 Medium (376~715px)",
    desc: "iPhone 11~ \u00b7 iPhone Pro 14~ \u00b7 Galaxy S21~ \u00b7 Note \uc2dc\ub9ac\uc988 \u00b7 Fold Cover",
    options: [
      { value: "390" as const, label: "390px \u00b7 iPhone 14/15/16 Pro" },
      { value: "430" as const, label: "430px \u00b7 iPhone 14/15/16 Pro Max" },
      { value: "580" as const, label: "580px \u00b7 Galaxy Fold 5 Cover dp" },
    ],
  },
  {
    label: "\ud83d\udda5 Tablet \u2014 Large (716~1279px)",
    desc: "iPad \u00b7 Galaxy Tab \u00b7 Galaxy Fold Main dp",
    options: [
      { value: "716" as const, label: "716px \u00b7 Galaxy Fold Main dp" },
      { value: "768" as const, label: "768px \u00b7 iPad mini \u00b7 Galaxy Tab" },
      { value: "1024" as const, label: "1024px \u00b7 iPad / iPad Air" },
    ],
  },
] as const;

export const VIEWPORTS: Record<ViewportPreset, { width: number; height: number; deviceScaleFactor: number }> = {
  "320":  { width: 320,  height: 568,  deviceScaleFactor: 2 },
  "375":  { width: 375,  height: 812,  deviceScaleFactor: 2 },
  "390":  { width: 390,  height: 844,  deviceScaleFactor: 3 },
  "430":  { width: 430,  height: 932,  deviceScaleFactor: 3 },
  "580":  { width: 580,  height: 1024, deviceScaleFactor: 2 },
  "716":  { width: 716,  height: 1368, deviceScaleFactor: 2 },
  "768":  { width: 768,  height: 1024, deviceScaleFactor: 2 },
  "1024": { width: 1024, height: 1366, deviceScaleFactor: 2 },
};

export function severityToLabel(s: Severity) {
  if (s === "pass") return "PASS";
  if (s === "warn") return "WARN";
  return "FAIL";
}

export function matchMethodLabel(m: MatchMethod, score?: number | null): string {
  if (!m) return "미매칭";
  if (m === "mapping") return "매핑";
  if (m === "name-exact") return "이름";
  if (m === "name-normalized") return "이름(유사)";
  if (m === "iou") return score != null ? `위치 ${Math.round(score * 100)}%` : "위치";
  if (m === "text") return "텍스트";
  return m;
}

export function matchMethodColor(m: MatchMethod): string {
  if (!m) return "#999";
  if (m === "mapping" || m === "name-exact") return "#059669"; // green
  if (m === "name-normalized") return "#0891b2"; // cyan
  if (m === "iou") return "#d97706"; // amber
  if (m === "text") return "#7c3aed"; // violet
  return "#6b7280";
}

export function prioritizeRows<T extends { key: string }>(rows: T[]): T[] {
  const priority = ["fontSize", "color", "backgroundColor", "lineHeight", "fontWeight"];
  const pr = new Map(priority.map((k, i) => [k, i]));
  return [...rows].sort((a, b) => {
    const pa = pr.has(a.key) ? (pr.get(a.key) as number) : 999;
    const pb = pr.has(b.key) ? (pr.get(b.key) as number) : 999;
    if (pa !== pb) return pa - pb;
    return a.key.localeCompare(b.key);
  });
}
