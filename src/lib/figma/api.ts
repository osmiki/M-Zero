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

export async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

export async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

export function truncate(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * Figma REST API로 노드의 렌더링 이미지 URL을 가져옵니다.
 * 반환되는 URL은 임시 S3 URL (약 30분 유효).
 */
export async function fetchFigmaImage(args: {
  token: string;
  fileKey: string;
  nodeId: string;
  scale?: number;
  format?: "png" | "jpg" | "svg";
}): Promise<string> {
  const { token, fileKey, nodeId, scale = 2, format = "png" } = args;
  const ids = encodeURIComponent(nodeId);
  const url = `https://api.figma.com/v1/images/${fileKey}?ids=${ids}&format=${format}&scale=${scale}`;

  const res = await fetchWithTimeout(
    url,
    { headers: { "X-Figma-Token": token }, cache: "no-store" },
    25_000
  );

  if (!res.ok) {
    const text = await safeReadText(res);
    throw new Error(`Figma image API failed: HTTP ${res.status} — ${truncate(text, 200)}`);
  }

  const json = await res.json();
  const images = json?.images as Record<string, string | null> | undefined;
  if (!images) throw new Error("Figma image API: no images in response");

  const imageUrl = Object.values(images)[0];
  if (!imageUrl) throw new Error("Figma image API: image URL is null (node may not be renderable)");

  return imageUrl;
}
