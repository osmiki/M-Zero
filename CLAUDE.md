# Design QA Agent

Figma 디자인 토큰과 웹 CSS computed style을 자동 비교하는 QA 도구.

## Tech Stack
- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript (strict)
- **UI**: React 19
- **Web Scraping**: Playwright 1.55
- **Validation**: Zod 4
- **Browser Extension**: Chrome Manifest V3

## Directory Structure
```
src/
├── app/
│   ├── page.tsx            — 메인 UI (상태 소유)
│   ├── components/         — UI 컴포넌트
│   ├── hooks/              — Custom hooks
│   └── api/                — API 라우트
│       ├── compare/        — 비교 엔진 오케스트레이션
│       ├── run/            — Playwright 실행
│       ├── web-data/       — 웹 데이터 업로드/조회
│       ├── auth/           — Figma OAuth + 토큰 상태
│       └── jobs/           — 작업 상태 폴링
├── lib/
│   ├── compare/            — 비교 엔진 (속성별 비교)
│   ├── figma/              — Figma API 통합
│   ├── normalize.ts        — 색상/px 정규화
│   ├── webDataStore.ts     — 파일 기반 저장소
│   ├── sessionStore.ts     — 세션 관리
│   ├── jobs.ts             — 작업 추적
│   └── viewport.ts         — 뷰포트 프리셋
chrome-extension/           — Chrome 확장 프로그램
```

## Commands
- `npm run dev` — 개발 서버 (port 3022)
- `npm run build` — 프로덕션 빌드
- `npm start` — 프로덕션 서버

## Environment Variables
- `.env.local` 참조 (gitignore됨)
- `FIGMA_TOKEN` — 서버 공용 Figma PAT (설정 시 UI 토큰 입력 불필요)
- `FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET` — OAuth (선택)
