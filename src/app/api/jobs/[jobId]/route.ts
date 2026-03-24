import { NextResponse } from "next/server";
import { getJob } from "@/lib/jobs";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await ctx.params;
  const job = getJob(jobId);
  if (!job) {
    return NextResponse.json({ ok: false, error: "job not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, job });
}

