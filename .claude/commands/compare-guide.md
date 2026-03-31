---
description: Design QA 비교 로직 수정 가이드. 비교 알고리즘, 매칭, 색상/타이포/그림자 비교 규칙 변경 시 참조.
---

# 비교 로직 수정 가이드

비교 로직을 수정할 때 이 가이드를 참조하세요. 각 모듈의 역할과 핵심 규칙을 정리합니다.

## 파일 구조

```
src/lib/compare/                    ← 속성별 비교 엔진
  ├── index.ts                      (re-export)
  ├── compareEngine.ts              (메인 함수: compareTokenToComputed)
  ├── types.ts                      (CompareConfig, CompareRow, DiffItem 등)
  └── helpers.ts                    (pushPx, pushColor, parseCssBoxShadow 등)

src/lib/figma/                      ← Figma API 토큰 추출
  ├── index.ts                      (re-export)
  ├── api.ts                        (assertPersonalAccessToken, fetchWithTimeout)
  ├── extractors.ts                 (extractFigmaTokensFromNode + 내부 헬퍼)
  ├── parser.ts                     (parseFigmaDevModeUrl, normalizeNodeId)
  └── types.ts                      (FigmaToken)

src/app/api/compare/route.ts        ← 오케스트레이션 (매칭 + 비교 호출)
src/lib/normalize.ts                ← 공유 유틸 (색상 정규화, px 파싱)
```

## 핵심 규칙

### 매칭 (route.ts)
요소 매칭 우선순위:
1. **명시적 매핑**: `nodeClassMapping`에 지정된 Figma노드→CSS클래스
2. **IoU bbox 매칭**: Figma bbox를 웹 스케일로 변환 후 IoU ≥ 0.25이면 매칭
3. **이름 기반 (exact)**: Figma className === web className
4. **이름 기반 (normalized)**: `canonicalKey()` — lowercase + `\W_` 제거 후 비교
5. **이름 기반 (fuzzy)**: canonical key의 containment + 길이 유사도 ≥ 0.6

### 비교 모드 (compareEngine.ts)
Figma 노드 타입에 따라 자동 결정:
- **strict** (COMPONENT / INSTANCE / COMPONENT_SET): 모든 속성 비교
  - Layout(W/H), Spacing(padding/gap), Typography, Color, Border-radius, Opacity, Stroke, Shadow, Animation, TagName
- **foundational** (FRAME / GROUP / RECTANGLE 등): Foundation 값만 비교
  - Typography, Color, Border-radius, Opacity

### 색상 비교
- sRGB 유클리드 거리: `√((R1-R2)² + (G1-G2)² + (B1-B2)²)`
- 거리 ≤ 10 → **PASS**, > 10 → **FAIL**
- 토큰명 불일치(hex 값은 동일) → **FAIL** + `tokenMismatch` 플래그 → UI에서 "토큰↕" 배지 표시
- 양쪽 모두 alpha=0 (투명) → **PASS**
- Figma TEXT 노드가 웹에서 wrapper로 감싸진 경우 → `_textChildColor` 사용

### 타이포그래피
| 속성 | 비교 방식 |
|------|-----------|
| fontSize | ±thresholdPx |
| fontWeight | exact match (100~900) |
| lineHeight | ±thresholdPx (unitless→px 변환) |
| letterSpacing | ±thresholdPx (unitless→px 변환) |
| fontFamily | Apple 시스템 폰트(SF Pro Display, SF Pro Text, -apple-system, BlinkMacSystemFont 등)이면 **스킵** |
| fontStyle | italic인 경우에만 비교 ("Regular"는 스킵) |

### 그림자 (box-shadow)
- Figma: effects[] 배열의 **첫 번째 visible effect**만 비교
- CSS: `parseCssBoxShadow()`로 x, y, blur, spread, color 파싱
- 5개 컴포넌트 모두 threshold 이내여야 PASS
- inset 플래그도 비교

### 텍스트 자식 매칭 스코어
Figma COMPONENT의 내부 TEXT 노드들과 웹 텍스트 노드를 매칭:
- **Content** (50%): `tokenSimilarity()` — 문자/토큰 오버랩 ≥ 80% → 50점
- **Position** (30%): 상대 인덱스 차이 → (1 - |diff|) × 30
- **Style** (20%): fontSize 비율 차이 → (1 - min(diff, 1)) × 20
- **Keyword 보너스** (+30): 가변 텍스트(숫자/날짜/가격)일 때, figma 노드명 키워드가 web className+text에 포함되면 +30

### Stroke 비교 (strict 모드만)
- 4방향(top/right/bottom/left) border 중 최대값
- border width=0이면 outline 폴백
- width + color 모두 매칭 필요

## 수정 시 주의사항

1. **helpers.ts의 push* 함수들**: `rows[]`와 `diffs[]`에 동시 push하는 패턴. 새 비교 항목 추가 시 반드시 양쪽 모두 push할 것.
2. **normalize.ts**: compare/와 figma/ 양쪽에서 사용하는 공유 유틸. 변경 시 양쪽 영향 확인.
3. **외부 import**: 반드시 `index.ts` 통해서만. 내부 파일 직접 import 금지.
4. **compareMode 분기**: 새 속성 추가 시 strict/foundational 중 어디에 해당하는지 명확히 지정.
5. **severity**: 현재 pass/fail 2단계만 사용 (warn 없음). `severityFromDiffs()`에서 결정.
