import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { consumeOAuthState, createSession, getSessionCookieName, setFigmaSession } from "@/lib/sessionStore";

export const runtime = "nodejs";

type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  user_id_string?: string;
  user_id?: number;
};

function getOrigin(req: Request) {
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://127.0.0.1:3028";
  }
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code") ?? "";
  const state = u.searchParams.get("state") ?? "";

  if (!code || !state) {
    return NextResponse.json({ ok: false, error: "OAuth callback 파라미터(code/state)가 없습니다." }, { status: 400 });
  }

  const clientId = process.env.FIGMA_CLIENT_ID?.trim();
  const clientSecret = process.env.FIGMA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return NextResponse.json(
      { ok: false, error: "서버에 FIGMA_CLIENT_ID/FIGMA_CLIENT_SECRET이 설정되어 있지 않습니다." },
      { status: 500 }
    );
  }

  const st = consumeOAuthState(state);
  if (!st) {
    return NextResponse.json({ ok: false, error: "OAuth state가 유효하지 않습니다(만료/불일치)." }, { status: 400 });
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64");
  const body = new URLSearchParams();
  body.set("redirect_uri", st.redirectUri);
  body.set("code", code);
  body.set("grant_type", "authorization_code");
  body.set("code_verifier", st.codeVerifier);

  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://api.figma.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body,
      cache: "no-store",
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Figma OAuth 토큰 교환에 실패했습니다(네트워크)." },
      { status: 502 }
    );
  }

  const text = await tokenRes.text().catch(() => "");
  if (!tokenRes.ok) {
    return NextResponse.json(
      { ok: false, error: `Figma OAuth token exchange 실패 (HTTP ${tokenRes.status})\n${text}`.trim() },
      { status: 502 }
    );
  }

  let json: TokenResponse;
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    return NextResponse.json({ ok: false, error: "Figma OAuth 응답 파싱에 실패했습니다." }, { status: 502 });
  }

  if (!json.access_token) {
    return NextResponse.json({ ok: false, error: "Figma OAuth 응답에 access_token이 없습니다." }, { status: 502 });
  }

  const sess = createSession();
  const expiresAt =
    typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? Date.now() + json.expires_in * 1000 : undefined;

  setFigmaSession(sess.id, {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt,
    userIdString: json.user_id_string,
  });

  const c = await cookies();
  c.set(getSessionCookieName(), sess.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 60 * 60 * 24 * 90, // 90d
  });

  const appOrigin = getOrigin(req);
  return NextResponse.redirect(`${appOrigin}/?connected=figma`, { status: 302 });
}

