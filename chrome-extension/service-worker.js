const DEFAULT_ORIGIN = "http://localhost:3022";

const PICK_KEYS = [
  "width","height",
  "paddingTop","paddingRight","paddingBottom","paddingLeft",
  "marginTop","marginRight","marginBottom","marginLeft",
  "gap","fontSize","fontWeight","fontFamily","lineHeight","letterSpacing",
  "fontStyle","textDecoration","textTransform",
  "color","backgroundColor","borderRadius","opacity",
  "borderTopWidth","borderTopColor","borderTopStyle",
  "borderRightWidth","borderRightColor","borderRightStyle",
  "borderBottomWidth","borderBottomColor","borderBottomStyle",
  "borderLeftWidth","borderLeftColor","borderLeftStyle",
  "outlineWidth","outlineColor","outlineStyle",
  "boxShadow",
];

// ── 앱 origin ──────────────────────────────────────────────────────────────
async function getOrigin() {
  const { appOrigin } = await chrome.storage.sync.get({ appOrigin: DEFAULT_ORIGIN });
  try { return `${new URL(appOrigin).protocol}//${new URL(appOrigin).host}`; }
  catch { return DEFAULT_ORIGIN; }
}

// ── 메시지 핸들러 ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "extract_upload_open") return;
  run().then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true;
});

// ══════════════════════════════════════════════════════════════════════════
//  메인 흐름: 4-phase
// ══════════════════════════════════════════════════════════════════════════
async function run() {
  const origin = await getOrigin();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const tabId   = tab.id;
  const windowId = tab.windowId;

  // ── Phase 1: CSS 데이터 선추출 (스크롤 없이) ─────────────────────────
  // 스크롤 전 DOM 상태 그대로 className + computedStyle 수집
  const [{ result: vpRaw }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      w: window.innerWidth,
      h: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    }),
    world: "MAIN",
  });

  const [{ result: cssData }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: fastExtract,
    args: [PICK_KEYS],
    world: "MAIN",
  });
  if (!cssData) throw new Error("CSS extraction failed");

  // ── Phase 2: 스크롤 & 캡처 루프 ─────────────────────────────────────
  // GoFullPage 방식: top → bottom 순차 스크롤, 각 뷰포트 captureVisibleTab
  let strips = null;
  let fixedRects = null;
  try {
    const loopResult = await captureLoop(tabId, windowId, vpRaw);
    strips = loopResult?.strips ?? null;
    fixedRects = loopResult?.fixedRects ?? null;
  } catch (e) {
    console.warn("[QA] captureLoop error:", e);
  }

  // ── Phase 2.5: 스크롤 완료 후 CSS 재추출 ────────────────────────────
  // SPA lazy-load: 스크롤 전에는 DOM에 없던 요소들이 이제 존재함
  // 재추출 결과가 있으면 초기 추출값 대체 (더 많은 요소 포함)
  try {
    const [{ result: cssDataAfterScroll }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fastExtract,
      args: [PICK_KEYS],
      world: "MAIN",
    });
    if (cssDataAfterScroll && Object.keys(cssDataAfterScroll.elements ?? {}).length > Object.keys(cssData.elements ?? {}).length) {
      // 더 많은 요소를 잡은 경우에만 교체 (href, viewport 등은 초기값 유지)
      cssData.elements = cssDataAfterScroll.elements;
      cssData.scrollHeight = cssDataAfterScroll.scrollHeight;
    }
  } catch (e) {
    console.warn("[QA] post-scroll CSS re-extract failed:", e);
  }

  // ── Phase 3: 캔버스 합성 → 단일 screenshotDataUrl ───────────────────
  // 페이지 컨텍스트에서 createImageBitmap(Blob) 방식으로 합성
  // (img-src CSP 우회 + canvas taint 없음)
  let screenshotDataUrl = null;
  if (strips && strips.length >= 1) {
    screenshotDataUrl = await stitchInPage(tabId, strips, vpRaw);
  }
  // 합성 실패 → 단일 뷰포트 폴백
  if (!screenshotDataUrl) {
    try {
      screenshotDataUrl = await Promise.race([
        chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 }),
        sleep(4000).then(() => null),
      ]);
    } catch { screenshotDataUrl = null; }
  }

  // 실제 페이지 높이 = 마지막 스트립 scrollY + 뷰포트 높이
  const actualScrollHeight = strips && strips.length > 0
    ? strips[strips.length - 1].scrollY + vpRaw.h
    : cssData.scrollHeight ?? vpRaw.h;

  // ── Phase 4: 일괄 업로드 ─────────────────────────────────────────────
  const payload = {
    ...cssData,
    scrollHeight: Math.round(actualScrollHeight),
    // screenshotDataUrl: null이면 필드 자체를 제외 (Zod .optional() 대응)
    ...(screenshotDataUrl ? { screenshotDataUrl } : {}),
  };

  const res = await fetch(`${origin}/api/web-data`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.webDataId) {
    const serverErr = json?.error ?? "(no body)";
    throw new Error(`Upload failed: ${res.status} — ${serverErr}`);
  }

  await chrome.tabs.create({ url: `${origin}/?webDataId=${encodeURIComponent(json.webDataId)}` });
  return { ok: true, webDataId: json.webDataId };
}

// ══════════════════════════════════════════════════════════════════════════
//  Phase 2: 스크롤 & 캡처 루프
// ══════════════════════════════════════════════════════════════════════════
async function captureLoop(tabId, windowId, { w, h, dpr }) {
  const MAX_STRIPS = 25;

  // ── 스크롤 헬퍼 (탐지된 방식에 따라 분기) ──
  const scrollTo = (y) => chrome.scripting.executeScript({
    target: { tabId },
    func: (y) => {
      const sc = window.__qa_sc__;
      if (!sc || sc === "window") window.scrollTo({ top: y, behavior: "instant" });
      else if (sc === "documentElement") document.documentElement.scrollTop = y;
      else if (sc === "body") document.body.scrollTop = y;
      else sc.scrollTop = y;
    },
    args: [y], world: "MAIN",
  });

  const getScrollY = async () => {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const sc = window.__qa_sc__;
        if (!sc || sc === "window") return window.scrollY;
        if (sc === "documentElement") return document.documentElement.scrollTop;
        if (sc === "body") return document.body.scrollTop;
        return typeof sc.scrollTop === "number" ? sc.scrollTop : 0;
      },
      world: "MAIN",
    });
    return typeof result === "number" ? result : 0;
  };

  // ── Step 1: 스크롤바 숨김 ──
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const s = document.createElement("style");
      s.id = "__qa_sb__";
      s.textContent = "*::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}";
      document.head.appendChild(s);
    },
    world: "MAIN",
  });

  // ── Step 2: 레이지 로딩 트리거 ──
  // SPA는 초기 scrollHeight ≈ viewportHeight → 스크롤 이벤트가 없으면 콘텐츠 미로드
  // window 와 내부 overflow 컨테이너 둘 다 맨 아래로 내렸다가 복귀
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // 가장 큰 overflow 컨테이너 찾기 (없으면 null)
      const el = Array.from(document.querySelectorAll("*")).filter(e => {
        const s = getComputedStyle(e);
        return (s.overflowY === "scroll" || s.overflowY === "auto") && e.clientHeight > 100;
      }).sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;

      window.__qa_lazy_el__ = el;
      if (el) el.scrollTop = 999999;
      window.scrollTo({ top: 999999, behavior: "instant" });
    },
    world: "MAIN",
  });
  await sleep(1300); // 레이지 콘텐츠 로드 대기

  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      if (window.__qa_lazy_el__) window.__qa_lazy_el__.scrollTop = 0;
      delete window.__qa_lazy_el__;
      window.scrollTo({ top: 0, behavior: "instant" });
    },
    world: "MAIN",
  });
  await sleep(400);

  // ── Step 3: 스크롤 방식 탐지 (콘텐츠 로드 후 정확하게) ──
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const PROBE = 200;

      // window
      window.scrollTo({ top: PROBE, behavior: "instant" });
      if (window.scrollY >= PROBE - 5) {
        window.scrollTo({ top: 0, behavior: "instant" }); window.__qa_sc__ = "window"; return;
      }
      window.scrollTo({ top: 0, behavior: "instant" });

      // documentElement
      document.documentElement.scrollTop = PROBE;
      if (document.documentElement.scrollTop >= PROBE - 5) {
        document.documentElement.scrollTop = 0; window.__qa_sc__ = "documentElement"; return;
      }
      document.documentElement.scrollTop = 0;

      // body
      document.body.scrollTop = PROBE;
      if (document.body.scrollTop >= PROBE - 5) {
        document.body.scrollTop = 0; window.__qa_sc__ = "body"; return;
      }
      document.body.scrollTop = 0;

      // overflow 내부 컨테이너 (scrollHeight > clientHeight인 것 중 가장 큰 것)
      const best = Array.from(document.querySelectorAll("*"))
        .filter(el => {
          if (el.scrollHeight <= el.clientHeight + 20) return false;
          const s = getComputedStyle(el);
          return s.overflowY === "scroll" || s.overflowY === "auto";
        })
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] ?? null;

      if (best) {
        best.scrollTop = PROBE;
        if (best.scrollTop >= PROBE - 5) {
          best.scrollTop = 0; window.__qa_sc__ = best; return;
        }
        best.scrollTop = 0;
      }

      window.__qa_sc__ = "window"; // 폴백
    },
    world: "MAIN",
  });
  await sleep(100);

  // ── Step 4: fixed/sticky 요소 탑/바텀 분류 + CSS 셀렉터 수집 ──
  // React 재렌더링 시 DOM 참조가 무효화되므로 클래스명 기반 셀렉터를 사용
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const vpH = window.innerHeight;
      const els = Array.from(document.querySelectorAll("*")).filter(el => {
        const pos = getComputedStyle(el).position;
        return pos === "fixed" || pos === "sticky";
      });

      // 클래스명 기반 셀렉터 생성 (재렌더링 후에도 CSS가 작동)
      // ALL 클래스 사용 → 매우 구체적인 셀렉터로 다른 요소에 오버매칭 방지
      const toSelector = (el) => {
        if (el.id) return `#${CSS.escape(el.id)}`;
        const cls = Array.from(el.classList).map(c => `.${CSS.escape(c)}`).join('');
        return cls.length > 0 ? `${el.tagName.toLowerCase()}${cls}` : null;
      };

      const top = els.filter(el => el.getBoundingClientRect().top < vpH / 2);
      const bot = els.filter(el => el.getBoundingClientRect().top >= vpH / 2);

      window.__qa_top_fixed__ = top;
      window.__qa_bot_fixed__ = bot;
      window.__qa_top_sel__ = top.map(toSelector).filter(Boolean);
      window.__qa_bot_sel__ = bot.map(toSelector).filter(Boolean);
      window.__qa_fixed_orig__ = els.map(el => ({ el, vis: el.style.visibility }));
    },
    world: "MAIN",
  });

  // fixed 요소 가시성 제어 헬퍼
  // 1) CSS 클래스 셀렉터 주입 (안정적 class명 기반)
  // 2) 캡처 직전 DOM 실시간 재조회 + inline style 직접 적용
  //    → React 리마운트로 새 DOM이 생겨도 캡처 직전에 현재 요소를 잡아 숨김
  const setFixed = async (hideTop, hideBot) => chrome.scripting.executeScript({
    target: { tabId },
    func: (hideTop, hideBot) => {
      document.getElementById("__qa_vis__")?.remove();

      // ① CSS 클래스 셀렉터 주입 (안정적인 경우 대비)
      const selectors = [
        ...(hideTop ? (window.__qa_top_sel__ ?? []) : []),
        ...(hideBot ? (window.__qa_bot_sel__ ?? []) : []),
      ];
      if (selectors.length > 0) {
        const style = document.createElement("style");
        style.id = "__qa_vis__";
        style.textContent = selectors.map(s => `${s}{visibility:hidden!important;}`).join('');
        document.head.appendChild(style);
      }

      // ② 실시간 DOM 재조회 → 현재 fixed 요소에 직접 inline style 적용
      // React 리마운트로 새 DOM이 생겨도 캡처 직전에 현재 요소를 잡으므로 항상 작동
      const vpH = window.innerHeight;
      try {
        const allCurrentFixed = Array.from(document.querySelectorAll("*")).filter(el => {
          try { return window.getComputedStyle(el).position === "fixed"; } catch { return false; }
        });
        for (const el of allCurrentFixed) {
          try {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            const isTopEl = r.top < vpH / 2;
            const shouldHide = (hideTop && isTopEl) || (hideBot && !isTopEl && r.top < vpH);
            if (shouldHide) {
              el.style.setProperty('visibility', 'hidden', 'important');
            } else {
              el.style.removeProperty('visibility');
            }
          } catch(_) {}
        }
      } catch(_) {}
    },
    args: [hideTop, hideBot],
    world: "MAIN",
  });

  // ── Step 5: 상단부터 순차 캡처 ──
  const strips = [];
  let scrollY = 0;
  let guard = 0;

  // 맨 위로 확실히 복귀
  await scrollTo(0);
  await sleep(200);

  // captureVisibleTab 래퍼: 에러 catch + 재시도 1회
  const capture = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = await Promise.race([
          chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 }),
          sleep(5000).then(() => { throw new Error("capture timeout"); }),
        ]);
        return url;
      } catch (e) {
        if (attempt === 0) {
          // 속도 제한 초과 시 750ms 대기 후 재시도
          await sleep(750);
        }
      }
    }
    return null;
  };

  while (guard++ < MAX_STRIPS) {
    const isFirst = strips.length === 0;
    // 첫 strip: 탑바 보임 + 하단 네비 숨김 / 중간: 모두 숨김
    await setFixed(!isFirst, true);

    const dataUrl = await capture();
    if (!dataUrl) break;

    strips.push({ scrollY, dataUrl });

    // 다음 위치로 스크롤
    const nextY = scrollY + h;
    await scrollTo(nextY);
    await sleep(600); // captureVisibleTab 제한(초당 2회) 준수 + 레이지 이미지 렌더링 대기

    const realY = await getScrollY();

    if (realY < nextY - 5) {
      // 스크롤 한계 도달 → 마지막 strip: 탑바 숨김 + 하단 네비 보임
      if (realY > scrollY + 5) {
        await setFixed(true, false);
        const last = await capture();
        if (last) strips.push({ scrollY: realY, dataUrl: last });
      } else {
        // 한 화면짜리: 탑바 + 하단 네비 모두 보이도록 다시 캡처 (둘 다 같은 뷰포트에 존재)
        await setFixed(false, false);
        const both = await capture();
        if (both && strips.length > 0) {
          strips[strips.length - 1] = { scrollY: strips[strips.length - 1].scrollY, dataUrl: both };
        }
      }
      break;
    }
    scrollY = realY;
  }

  // ── 고정 요소 bbox 수집 (cleanup 전에 실행: canvas 이레이즈용) ──
  // DOM 직접 재조회: React 재렌더링으로 저장된 참조가 stale(분리된 DOM)이 되면
  // getBoundingClientRect() → 모두 0 반환 → erasure 조건 미충족 → nav 이레이즈 실패
  // 해결: 저장된 참조 대신 querySelectorAll로 현재 DOM의 fixed 요소를 새로 조회
  let fixedRects = null;
  try {
    const [{ result: fr }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const vpH = window.innerHeight;
        let topH = 0;
        let botY = vpH;
        // 현재 DOM에서 position:fixed 요소를 직접 재조회 (stale ref 방지)
        const allFixed = Array.from(document.querySelectorAll("*")).filter(el => {
          try { return window.getComputedStyle(el).position === "fixed"; } catch { return false; }
        });
        for (const el of allFixed) {
          try {
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (r.top < vpH / 2) {
              topH = Math.max(topH, r.bottom);
            } else if (r.top >= vpH / 2 && r.top < vpH) {
              botY = Math.min(botY, r.top);
            }
          } catch (_) {}
        }
        return { topH, botY, vpH };
      },
      world: "MAIN",
    });
    fixedRects = fr;
  } catch (_) {}

  // ── 정리: fixed/sticky 복원 + 스크롤바 복원 + 맨 위로 ──
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // CSS 주입 제거 + 인라인 style 원복 (Phase 2.5 재추출 시 visibility:hidden 오염 방지)
      document.getElementById("__qa_vis__")?.remove();
      (window.__qa_fixed_orig__ ?? []).forEach(({ el, vis }) => {
        try { el.style.visibility = vis; } catch(_) {}
      });
      delete window.__qa_top_fixed__;
      delete window.__qa_bot_fixed__;
      delete window.__qa_top_sel__;
      delete window.__qa_bot_sel__;
      delete window.__qa_fixed_orig__;
      // 스크롤바 복원
      document.getElementById("__qa_sb__")?.remove();
      const sc = window.__qa_sc__;
      if (sc && typeof sc === "object") sc.scrollTop = 0;
      window.scrollTo({ top: 0, behavior: "instant" });
      delete window.__qa_sc__;
    },
    world: "MAIN",
  });

  return { strips: strips.length >= 1 ? strips : null, fixedRects };
}

// ══════════════════════════════════════════════════════════════════════════
//  Phase 3: 페이지 컨텍스트에서 Canvas 합성
//  - createImageBitmap(Blob) 방식: img-src CSP 우회, canvas taint 없음
//  - strips 배열을 executeScript args로 전달 → 페이지에서 canvas.toDataURL()
// ══════════════════════════════════════════════════════════════════════════
async function stitchInPage(tabId, strips, { w, h, dpr }) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (strips, vpW, vpH, dpr) => {
        try {
          const last = strips[strips.length - 1];
          const totalH = last.scrollY + vpH;

          const canvas = document.createElement("canvas");
          canvas.width  = Math.round(vpW * dpr);
          canvas.height = Math.round(totalH * dpr);
          const ctx = canvas.getContext("2d");
          if (!ctx) return null;

          for (const { scrollY: sy, dataUrl } of strips) {
            const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
            if (!m) continue;
            const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
            const blob  = new Blob([bytes], { type: m[1] });
            const bmp   = await createImageBitmap(blob);
            ctx.drawImage(bmp, 0, Math.round(sy * dpr));
            bmp.close();
          }

          const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
          return dataUrl.length > 200 ? dataUrl : null;
        } catch (e) {
          return null;
        }
      },
      args: [strips, w, h, dpr],
      world: "MAIN",
    });
    return result ?? null;
  } catch {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  Phase 1: CSS 추출 함수 (페이지 컨텍스트에서 실행)
// ══════════════════════════════════════════════════════════════════════════
function fastExtract(pickKeys) {
  const MAX = 1500; // 풀페이지 대응 (기존 600 → 1500, 하단 뷰포트 요소 누락 방지)
  const TRANSPARENT = "rgba(0, 0, 0, 0)";
  const scrollY = window.scrollY;
  const elements = {};
  let count = 0;

  // ── CSS Variable 역방향 맵 빌드: hex → "--var-name" ──────────────────────
  // :root 규칙에 정의된 색상 CSS 변수를 수집하여, 이후 요소의 color/backgroundColor 값이
  // 어떤 디자인 토큰(CSS 변수)에서 왔는지 역추적할 때 사용
  const cssVarColorMap = (() => {
    const map = {};

    // rgba(r,g,b,a) 문자열을 #rrggbbaa 로 변환
    const rgbaToHex8 = (str) => {
      const m = str && str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (!m) return null;
      const r = Math.round(+m[1]), g = Math.round(+m[2]), b = Math.round(+m[3]);
      const a = m[4] !== undefined ? Math.round(+m[4] * 255) : 255;
      const h = v => v.toString(16).padStart(2, '0');
      return `#${h(r)}${h(g)}${h(b)}${h(a)}`;
    };

    // hex #rrggbb 또는 #rrggbbaa 등을 #rrggbbaa 로 정규화
    const hexToHex8 = (str) => {
      const s = str.replace('#', '');
      if (s.length === 3) {
        const [r, g, b] = s.split('').map(c => parseInt(c + c, 16));
        return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}ff`;
      }
      if (s.length === 6) return `#${s}ff`;
      if (s.length === 8) return `#${s}`;
      return null;
    };

    // CSS 색상 문자열을 canvas로 #rrggbbaa 로 변환
    const colorToHex8 = (colorStr) => {
      if (!colorStr) return null;
      if (colorStr.startsWith('rgba') || colorStr.startsWith('rgb')) return rgbaToHex8(colorStr);
      if (colorStr.startsWith('#')) return hexToHex8(colorStr);
      // hsl, named 등은 canvas 방식
      try {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 1;
        const cx = cv.getContext('2d');
        cx.fillStyle = '#000000'; // reset
        cx.fillStyle = colorStr;
        const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
        const h = v => v.toString(16).padStart(2, '0');
        return `#${h(r)}${h(g)}${h(b)}${h(a)}`;
      } catch { return null; }
    };

    try {
      const rootEl = document.documentElement;
      const computedRoot = window.getComputedStyle(rootEl);
      for (const sheet of document.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (!(rule instanceof CSSStyleRule)) continue;
          const sel = rule.selectorText ?? '';
          // :root 또는 html 선택자에 정의된 CSS 변수만 수집
          if (!sel.includes(':root') && sel !== 'html') continue;
          const style = rule.style;
          for (let i = 0; i < style.length; i++) {
            const prop = style[i];
            if (!prop.startsWith('--')) continue;
            // 실제 계산된 값 (상속 해결된 값)
            const resolved = computedRoot.getPropertyValue(prop).trim();
            if (!resolved) continue;
            // 색상 값인지 확인 후 정규화
            if (resolved.startsWith('#') || resolved.startsWith('rgb') || resolved.startsWith('hsl') ||
                CSS.supports('color', resolved)) {
              const hex8 = colorToHex8(resolved);
              if (hex8 && !map[hex8]) map[hex8] = prop; // 첫 번째 매칭 토큰 우선
            }
          }
        }
      }
    } catch(_) {}
    return map;
  })();

  // 요소의 computed color 문자열을 hex8로 변환하여 CSS 변수명 조회
  const lookupCssVar = (colorStr) => {
    if (!colorStr || colorStr === TRANSPARENT) return null;
    const m = colorStr.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    const r = Math.round(+m[1]), g = Math.round(+m[2]), b = Math.round(+m[3]);
    const a = m[4] !== undefined ? Math.round(+m[4] * 255) : 255;
    const h = v => v.toString(16).padStart(2, '0');
    const hex8 = `#${h(r)}${h(g)}${h(b)}${h(a)}`;
    return cssVarColorMap[hex8] ?? null;
  };

  for (const el of document.querySelectorAll("[class]")) {
    if (count >= MAX) break;

    const r = el.getBoundingClientRect();
    // 크기 없는 요소만 skip — 뷰포트 밖 요소도 포함 (풀페이지 QA)
    if (r.width === 0 || r.height === 0) continue;

    const cs = window.getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;

    const computed = {};
    for (const k of pickKeys) computed[k] = cs[k] ?? "";
    computed._tagName = el.tagName.toLowerCase();

    // _fixedPosition: fixed 요소의 상단/하단 위치 표시 (오버레이 좌표 보정용)
    {
      const pos = cs.position;
      if (pos === "fixed") {
        computed._fixedPosition = r.top < window.innerHeight / 2 ? "top" : "bottom";
      }
    }

    // _textChildren: 컨테이너 내 모든 텍스트 리프 요소 수집 (Scoring 매칭용)
    // 각 요소: { text, index, fontSize, fontWeight, fontFamily, lineHeight, letterSpacing, color, classList }
    {
      const textChildren = [];
      let idx = 0;
      // 모든 자손 요소 중 직접 텍스트를 가진 리프 요소만 수집
      const allDescendants = Array.from(el.querySelectorAll('*'));
      for (const child of allDescendants) {
        const text = (child.innerText ?? child.textContent ?? '').trim();
        if (!text) continue;
        // 자식 중에 텍스트를 가진 요소가 있으면 리프가 아님 → 스킵
        const hasTextChild = Array.from(child.children).some(
          c => (c.innerText ?? c.textContent ?? '').trim()
        );
        if (hasTextChild) continue;
        const cs = window.getComputedStyle(child);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        textChildren.push({
          text,
          index: idx++,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontFamily: cs.fontFamily,
          lineHeight: cs.lineHeight,
          letterSpacing: cs.letterSpacing,
          color: cs.color,
          classList: Array.from(child.classList),
        });
      }
      if (textChildren.length > 0) {
        computed._textChildren = JSON.stringify(textChildren);
        // 하위 호환: 첫 번째 자식 값도 유지
        const first = textChildren[0];
        computed._textChildColor       = first.color;
        computed._textChildFontSize    = first.fontSize;
        computed._textChildFontWeight  = first.fontWeight;
        computed._textChildLineHeight  = first.lineHeight;
        computed._textChildFontFamily  = first.fontFamily;
        computed._textChildLetterSpacing = first.letterSpacing;
      }
    }

    if (computed.backgroundColor === TRANSPARENT && el.parentElement) {
      computed.backgroundColor = window.getComputedStyle(el.parentElement).backgroundColor;
    }

    // CSS 변수명 역추적: 어느 디자인 토큰에서 색상이 왔는지 저장
    {
      const colorVar = lookupCssVar(computed.color);
      if (colorVar) computed._colorVar = colorVar;
      const bgVar = lookupCssVar(computed.backgroundColor);
      if (bgVar) computed._backgroundColorVar = bgVar;
    }

    // textBbox: Range API로 실제 텍스트 글자 영역 계산 (여러 텍스트 노드의 합집합)
    // el과 텍스트 노드 사이에 고유 class를 가진 조상이 있으면 별도 컴포넌트로 간주 → 제외
    let textBbox = null;
    {
      const tw2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (tn) => {
          if (!tn.textContent?.trim()) return NodeFilter.FILTER_SKIP;
          let p = tn.parentNode;
          while (p && p !== el) {
            if (p.nodeType === 1 && p.classList?.length > 0) return NodeFilter.FILTER_SKIP;
            p = p.parentNode;
          }
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let hasText = false;
      let tn;
      const range = document.createRange();
      while ((tn = tw2.nextNode())) {
        range.selectNode(tn);
        const rects = range.getClientRects();
        for (const rect of rects) {
          if (rect.width <= 0 || rect.height <= 0) continue;
          hasText = true;
          if (rect.x < minX) minX = rect.x;
          if (rect.y < minY) minY = rect.y;
          if (rect.x + rect.width > maxX) maxX = rect.x + rect.width;
          if (rect.y + rect.height > maxY) maxY = rect.y + rect.height;
        }
      }
      if (hasText && maxX > minX && maxY > minY) {
        textBbox = { x: minX, y: minY + scrollY, width: maxX - minX, height: maxY - minY };
      }
    }

    const cls = Array.from(el.classList);
    const entry = {
      bbox: { x: r.x, y: r.y + scrollY, width: r.width, height: r.height },
      classList: cls,
      computed,
      ...(textBbox ? { textBbox } : {}),
    };
    for (const c of cls) {
      if (!elements[c]) { elements[c] = entry; break; }
    }
    count++;
  }

  return {
    href:       location.href,
    viewport:   { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
    scrollY,
    extractedAt: Date.now(),
    elements,
  };
}

// ── 유틸 ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
