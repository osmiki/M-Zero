import { NextResponse } from "next/server";
import { fetchFigmaImage } from "@/lib/figma";
import { cookies } from "next/headers";
import { getSession, getSessionCookieName } from "@/lib/sessionStore";

export const runtime = "nodejs";

/**
 * GET /api/figma/image?fileKey=...&nodeId=...&scale=2
 * Figma 렌더링 이미지를 프록시합니다 (CORS/Canvas taint 방지).
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const fileKey = url.searchParams.get("fileKey");
    const nodeId = url.searchParams.get("nodeId");
    const scale = Number(url.searchParams.get("scale") || "2");

    if (!fileKey || !nodeId) {
      return NextResponse.json({ ok: false, error: "fileKey and nodeId are required" }, { status: 400 });
    }

    const c = await cookies();
    const sid = c.get(getSessionCookieName())?.value ?? null;
    const sess = getSession(sid);
    const oauthToken = sess?.figma?.accessToken;
    const token = process.env.FIGMA_TOKEN ?? oauthToken ?? url.searchParams.get("token");

    if (!token) {
      return NextResponse.json({ ok: false, error: "Figma token not available" }, { status: 400 });
    }

    const imageUrl = await fetchFigmaImage({ token, fileKey, nodeId, scale });

    // Fetch the actual image bytes from the temporary S3 URL
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) {
      return NextResponse.json({ ok: false, error: `Failed to fetch image: ${imgRes.status}` }, { status: 502 });
    }

    const buffer = await imgRes.arrayBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": imgRes.headers.get("Content-Type") || "image/png",
        "Cache-Control": "private, max-age=1800",
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 500 }
    );
  }
}
