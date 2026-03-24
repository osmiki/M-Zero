import Anthropic from "@anthropic-ai/sdk";

export type VisualDiffItem = {
  area: string;
  description: string;
  severity: "fail" | "pass";
};

export type VisualCompareResult =
  | { ok: true; diffs: VisualDiffItem[]; model: string }
  | { ok: false; reason: string };

export async function runVisualCompare(args: {
  figmaBase64: string;
  webBase64: string;
}): Promise<VisualCompareResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: false, reason: "ANTHROPIC_API_KEY not set" };
  }
  if (args.webBase64.length > 5_000_000) {
    return { ok: false, reason: "스크린샷 크기 초과 (5MB 제한)" };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = "claude-opus-4-6";

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "다음 두 이미지를 비교해주세요. 첫 번째는 Figma 디자인, 두 번째는 실제 웹 구현 스크린샷입니다.",
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: args.figmaBase64 },
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: args.webBase64.startsWith("/9j") ? "image/jpeg" : "image/png",
              data: args.webBase64,
            },
          },
          {
            type: "text",
            text: `두 이미지의 시각적 차이를 분석해서 JSON 배열로만 응답하세요. 다른 텍스트는 절대 포함하지 마세요.

비교 기준:
- 색상 차이 (배경색, 텍스트 색, 보더 색 등)
- 타이포그래피 차이 (폰트 크기, 굵기, 스타일)
- 아이콘 유무 또는 변경
- 보더, 그림자, radius 차이
- 컴포넌트 추가/제거

제외 기준 (보고하지 마세요):
- 레이아웃, 위치, 여백 차이
- 텍스트 내용 차이
- 이미지/사진 내용 차이

응답 형식 (JSON array only, 최대 10개):
[
  { "area": "영역명", "description": "구체적 차이 설명", "severity": "fail" },
  { "area": "영역명", "description": "동일함", "severity": "pass" }
]

차이가 없으면 빈 배열 []을 반환하세요.`,
          },
        ],
      },
    ],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

  // Extract JSON array from response
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    return { ok: false, reason: `Claude 응답 파싱 실패: ${text.slice(0, 200)}` };
  }

  try {
    const diffs = JSON.parse(match[0]) as VisualDiffItem[];
    return { ok: true, diffs, model };
  } catch {
    return { ok: false, reason: `JSON 파싱 오류: ${match[0].slice(0, 200)}` };
  }
}
