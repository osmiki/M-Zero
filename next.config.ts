import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: __dirname,
  experimental: {
    serverActions: {
      // 전체 페이지 스크린샷 업로드를 위해 body 사이즈 제한 확대 (기본 4MB → 20MB)
      bodySizeLimit: "20mb",
    },
  },
  // Route Handler body 크기 제한 (긴 페이지 전체 캡처 대응)
  // Next.js 내부 httpAgentOptions가 아닌 Node.js HTTP 레벨에서 허용
  serverExternalPackages: [],
};

export default nextConfig;

