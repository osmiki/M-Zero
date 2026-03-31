import { NextResponse } from "next/server";
import { z } from "zod";
import { putWebData } from "@/lib/webDataStore";

export const runtime = "nodejs";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const BodySchema = z.object({
  href: z.string().url(),
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    devicePixelRatio: z.number().positive(),
  }),
  scrollHeight: z.number().positive().optional(),
  scrollY: z.number().min(0).optional(),
  extractedAt: z.number().int(),
  screenshotDataUrl: z.string().nullable().optional(),
  elements: z.record(
    z.string(),
    z.object({
      bbox: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable(),
      classList: z.array(z.string()),
      computed: z.record(z.string(), z.string()),
      textBbox: z
        .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
        .nullable()
        .optional(),
    })
  ),
});

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

// App Router route handler: body size limit 증가
// (서버 액션의 bodySizeLimit과 별개로, 스트림 직접 읽어 프레임워크 기본 제한 우회)
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    // 긴 페이지 전체 스크린샷 포함 시 페이로드가 10MB+ 될 수 있으므로
    // req.text() 로 스트림 직접 읽기 (req.json() 내부 버퍼 제한 우회)
    const text = await req.text();
    const body = BodySchema.parse(JSON.parse(text));
    const id = await putWebData(body);
    return NextResponse.json({ ok: true, webDataId: id }, { headers: corsHeaders });
  } catch (e) {
    console.error("[web-data POST] error:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Unknown error" },
      { status: 400, headers: corsHeaders }
    );
  }
}

