import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { deleteSession, getSessionCookieName } from "@/lib/sessionStore";

export const runtime = "nodejs";

export async function POST() {
  const c = await cookies();
  const sid = c.get(getSessionCookieName())?.value ?? null;
  if (sid) deleteSession(sid);
  c.set(getSessionCookieName(), "", { httpOnly: true, sameSite: "lax", secure: false, path: "/", maxAge: 0 });
  return NextResponse.json({ ok: true });
}

