import { NextResponse } from "next/server";
import crypto from "crypto";
import { base64Url, createOAuthState, sha256Base64Url } from "@/lib/sessionStore";

export const runtime = "nodejs";

function getRedirectUri(req: Request) {
  const env = process.env.FIGMA_REDIRECT_URI;
  if (env && env.trim()) return env.trim();
  const u = new URL(req.url);
  return `${u.origin}/api/auth/figma/callback`;
}

export async function GET(req: Request) {
  const clientId = process.env.FIGMA_CLIENT_ID?.trim();
  if (!clientId) {
    return NextResponse.json(
      { ok: false, error: "서버에 FIGMA_CLIENT_ID가 설정되어 있지 않습니다." },
      { status: 500 }
    );
  }

  const redirectUri = getRedirectUri(req);

  // PKCE (S256)
  const codeVerifier = base64Url(crypto.randomBytes(32));
  const codeChallenge = sha256Base64Url(codeVerifier);

  const state = createOAuthState({ redirectUri, codeVerifier });

  const scope = ["file_content:read", "current_user:read"].join(",");
  const authUrl = new URL("https://www.figma.com/oauth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scope);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return NextResponse.redirect(authUrl.toString(), { status: 302 });
}

