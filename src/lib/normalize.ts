export function roundPx(v: number) {
  return Math.round(v * 100) / 100;
}

export function parseCssPx(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (s === "normal" || s === "auto") return null;
  // Single value: "20px" or "20"
  const m = s.match(/^(-?\d+(\.\d+)?)(px)?$/);
  if (m) return roundPx(Number(m[1]));
  // Shorthand with two values: "20px 30px" (e.g. CSS gap computed style)
  // → take the first (row) value
  const mShorthand = s.match(/^(-?\d+(\.\d+)?)(px)?\s+(-?\d+(\.\d+)?)(px)?$/);
  if (mShorthand) return roundPx(Number(mShorthand[1]));
  // Handle "12.3rem" etc if computedStyle returns px already it's covered above.
  const m2 = s.match(/^(-?\d+(\.\d+)?)(rem|em)$/);
  if (m2) return roundPx(Number(m2[1]) * 16);
  return null;
}

export function normalizeColorToHex(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (s === "transparent") return "#00000000";

  // Common named colors (computedStyle usually returns rgb, but keep a small safe map)
  const named: Record<string, string> = {
    black: "#000000ff",
    white: "#ffffffff",
    red: "#ff0000ff",
    green: "#008000ff",
    blue: "#0000ffff",
    gray: "#808080ff",
    grey: "#808080ff",
    yellow: "#ffff00ff",
    magenta: "#ff00ffff",
    fuchsia: "#ff00ffff",
    cyan: "#00ffffff",
    aqua: "#00ffffff",
  };
  if (named[s]) return named[s];

  if (s.startsWith("#")) {
    const hex = s.replace("#", "");
    if (hex.length === 3) {
      const r = hex[0] + hex[0];
      const g = hex[1] + hex[1];
      const b = hex[2] + hex[2];
      return `#${r}${g}${b}ff`;
    }
    if (hex.length === 4) {
      const r = hex[0] + hex[0];
      const g = hex[1] + hex[1];
      const b = hex[2] + hex[2];
      const a = hex[3] + hex[3];
      return `#${r}${g}${b}${a}`;
    }
    if (hex.length === 6) return `#${hex}ff`;
    if (hex.length === 8) return `#${hex}`;
    return null;
  }

  const rgb = s.match(
    /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/
  );
  if (rgb) {
    const r = clamp255(Number(rgb[1]));
    const g = clamp255(Number(rgb[2]));
    const b = clamp255(Number(rgb[3]));
    const a = rgb[4] == null ? 1 : clamp01(Number(rgb[4]));
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}${toHex2(Math.round(a * 255))}`;
  }

  // Support modern space-separated syntax:
  // rgb(0 0 0) / rgba(0 0 0 / 0.5)
  const rgb2 = s.match(
    /^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)\s*)?\)$/
  );
  if (rgb2) {
    const r = clamp255(Number(rgb2[1]));
    const g = clamp255(Number(rgb2[2]));
    const b = clamp255(Number(rgb2[3]));
    const a = rgb2[4] == null ? 1 : clamp01(Number(rgb2[4]));
    return `#${toHex2(r)}${toHex2(g)}${toHex2(b)}${toHex2(Math.round(a * 255))}`;
  }

  return null;
}

function toHex2(n: number) {
  return n.toString(16).padStart(2, "0");
}

function clamp255(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}

