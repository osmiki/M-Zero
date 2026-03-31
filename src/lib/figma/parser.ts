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
