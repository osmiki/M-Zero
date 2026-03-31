import { NextResponse } from "next/server";
import { z } from "zod";
import { getWebDataAsync } from "@/lib/webDataStore";

export const runtime = "nodejs";

const ParamsSchema = z.object({
  webDataId: z.string().min(1),
});

export async function GET(_req: Request, ctx: { params: Promise<{ webDataId: string }> }) {
  const params = ParamsSchema.parse(await ctx.params);
  const web = await getWebDataAsync(params.webDataId);
  if (!web) {
    return NextResponse.json({ ok: false, error: "webDataId를 찾지 못했습니다." }, { status: 404 });
  }

  const url = web.screenshotDataUrl ?? null;
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "screenshot이 없습니다. 확장프로그램을 최신으로 새로고침 후 다시 업로드해주세요." },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, screenshotDataUrl: url });
}
