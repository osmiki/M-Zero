import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const configured = !!process.env.FIGMA_TOKEN;
  return NextResponse.json({ configured });
}
