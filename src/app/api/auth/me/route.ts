import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSession, getSessionCookieName } from "@/lib/sessionStore";

export const runtime = "nodejs";

export async function GET() {
  const c = await cookies();
  const sid = c.get(getSessionCookieName())?.value ?? null;
  const sess = getSession(sid);
  return NextResponse.json({
    ok: true,
    authenticated: Boolean(sess?.figma?.accessToken),
    userIdString: sess?.figma?.userIdString ?? null,
    expiresAt: sess?.figma?.expiresAt ?? null,
  });
}

