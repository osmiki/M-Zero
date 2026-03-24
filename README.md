# Design QA Agent (MVP)

Figma 디자인(토큰명/노드명)과 실제 운영 웹의 CSS 클래스명을 1:1로 매칭해서 computed style 기반으로 비교하는 **Design-to-Code QA 자동화 앱**입니다.

## 실행

1) 의존성 설치

```bash
cd "design-qa-agent"
npm install
```

Playwright 브라우저 설치(최초 1회)

```bash
npx playwright install chromium
```

2) Figma 토큰 설정(권장)

- 방법 A: UI에서 Personal Access Token 입력
- 방법 B: 환경변수 사용

```bash
export FIGMA_TOKEN="YOUR_FIGMA_PERSONAL_ACCESS_TOKEN"
```

3) 개발 서버 실행

```bash
npm run dev
```

브라우저에서 `http://localhost:3000` 접속 후, 운영 웹 URL + Figma Dev Mode URL(or FileKey) + Node ID를 넣고 **Run QA**를 누르세요.

## (추천) Chrome 확장으로 Web 데이터 업로드

Playwright 대신 **Chrome 확장(1클릭)**으로 운영 웹의 computed style을 추출해 업로드할 수 있습니다.

1) 앱 실행 (예: `http://127.0.0.1:3023`)
2) Chrome → `chrome://extensions` → Developer mode ON
3) **Load unpacked** → `design-qa-agent/chrome-extension` 폴더 선택
4) 확장 Options에서 **App origin**을 현재 앱 주소로 설정 (예: `http://127.0.0.1:3023`)
5) 운영 웹 탭에서 확장 아이콘 → **Extract & Upload** 클릭
   - 업로드 후 결과 페이지가 자동으로 열립니다.

### Cursor/샌드박스 환경 참고

일부 샌드박스 환경에서는 파일 워처 제한으로 `next dev`가 불안정할 수 있습니다. 그 경우 아래처럼 프로덕션 모드로 실행하세요.

```bash
npm run build
npm run start -- -H 127.0.0.1 -p 3002
```

## MVP 동작 방식

- **매칭 규칙**: Figma 노드의 `name` == 웹의 `.className` 일 때만 비교
- **추출**:
  - Figma: `fills`, `absoluteBoundingBox`, `style(fontSize/weight/lineHeight/letterSpacing)`, `itemSpacing`, `padding`, `cornerRadius`, `opacity`
  - Web: Playwright로 `getComputedStyle` + bounding box + 스크린샷
- **비교**: Layout / Typography / Style / (클래스 기반) Animation
- **오버레이**: FAIL/WARN 요소에 빨간/주황 보더로 표시, 클릭 시 툴팁으로 차이값 표시

