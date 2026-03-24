"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type ViewportPreset = "320" | "375" | "390" | "430" | "580" | "716" | "768" | "1024";

const VIEWPORT_GROUPS = [
  {
    label: "📱 Mobile — Small (320~375px)",
    desc: "iPhone SE · iPhone 6~8 · Galaxy S7~8 · Galaxy Fold Cover",
    options: [
      { value: "320", label: "320px · iPhone SE (1세대)" },
      { value: "375", label: "375px · iPhone 6~8 / SE2~3 · Galaxy S7~8" },
    ],
  },
  {
    label: "📱 Mobile — Medium (376~715px)",
    desc: "iPhone 11~ · iPhone Pro 14~ · Galaxy S21~ · Note 시리즈 · Fold Cover",
    options: [
      { value: "390", label: "390px · iPhone 14/15/16 Pro" },
      { value: "430", label: "430px · iPhone 14/15/16 Pro Max" },
      { value: "580", label: "580px · Galaxy Fold 5 Cover dp" },
    ],
  },
  {
    label: "🖥 Tablet — Large (716~1279px)",
    desc: "iPad · Galaxy Tab · Galaxy Fold Main dp",
    options: [
      { value: "716", label: "716px · Galaxy Fold Main dp" },
      { value: "768", label: "768px · iPad mini · Galaxy Tab" },
      { value: "1024", label: "1024px · iPad / iPad Air" },
    ],
  },
] as const;


type Severity = "pass" | "warn" | "fail";
type CompareMode = "strict" | "foundational";

type DiffItem = {
  key: string;
  figma?: string | number | null;
  web?: string | number | null;
  delta?: number | null;
  figmaHex?: string | null;
  webHex?: string | null;
  tokenMismatch?: boolean;
};

type MatchResult = {
  className: string;
  selector: string;
  matchedWebClassName?: string | null;
  severity: Severity;
  /** strict = COMPONENT/INSTANCE, foundational = FRAME/GROUP 등 */
  compareMode: CompareMode;
  diffs: DiffItem[];
  rows: Array<{ key: string; figma?: string | number | null; web?: string | number | null; delta?: number | null; ok: boolean; figmaHex?: string | null; webHex?: string | null; tokenMismatch?: boolean }>;
  bbox?: { x: number; y: number; width: number; height: number } | null;
  textBbox?: { x: number; y: number; width: number; height: number } | null;
  fixedPosition?: "top" | "bottom" | null;
  elementFound: boolean;
};

type CompareResponse =
  | {
      ok: true;
      summary: {
        total: number; pass: number; warn: number; fail: number; missing: number;
        /** COMPONENT/INSTANCE fail 수 */
        strictFail: number;
        /** FRAME/GROUP 등 Foundation fail 수 */
        foundationalFail: number;
      };
      results: MatchResult[];
      meta: {
        web: { href: string; extractedAt: number; viewport: { width: number; height: number; devicePixelRatio: number }; scrollHeight?: number; scrollY?: number; webDataId: string };
        figma: { fileKey: string; nodeId: string };
        thresholdPx: number;
      };
    }
  | { ok: false; error: string };

const VIEWPORTS: Record<ViewportPreset, { width: number; height: number; deviceScaleFactor: number }> = {
  "320":  { width: 320,  height: 568,  deviceScaleFactor: 2 },
  "375":  { width: 375,  height: 812,  deviceScaleFactor: 2 },
  "390":  { width: 390,  height: 844,  deviceScaleFactor: 3 },
  "430":  { width: 430,  height: 932,  deviceScaleFactor: 3 },
  "580":  { width: 580,  height: 1024, deviceScaleFactor: 2 },
  "716":  { width: 716,  height: 1368, deviceScaleFactor: 2 },
  "768":  { width: 768,  height: 1024, deviceScaleFactor: 2 },
  "1024": { width: 1024, height: 1366, deviceScaleFactor: 2 },
};

function severityToLabel(s: Severity) {
  switch (s) {
    case "pass":
      return "PASS";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
  }
}

export default function HomePage() {
  const [figmaUrlOrKey, setFigmaUrlOrKey] = useState("");
  const [figmaToken, setFigmaToken] = useState("");
  const [viewportPreset, setViewportPreset] = useState<ViewportPreset>("375");
  const [thresholdPx, setThresholdPx] = useState<number>(2);
  const [running, setRunning] = useState(false);
  const [webDataId, setWebDataId] = useState("");
  const [showManualWebData, setShowManualWebData] = useState(false);
  const [resp, setResp] = useState<CompareResponse | null>(null);
  const [job, setJob] = useState<any | null>(null);
  const [selected, setSelected] = useState<MatchResult | null>(null);
  const [resultTab, setResultTab] = useState<"screen" | "text">("screen");
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [screenshotErr, setScreenshotErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  // Feature 2: Annotations
  const figmaFileKey = resp && resp.ok ? resp.meta.figma.fileKey : null;
  const figmaNodeId  = resp && resp.ok ? resp.meta.figma.nodeId  : null;
  const { store: annStore, setAnn } = useAnnotations(figmaFileKey, figmaNodeId);

  // Feature 3: History
  const { entries: historyEntries, save: saveHistory, remove: removeHistory } = useHistory();

  const viewport = VIEWPORTS[viewportPreset];

  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const id = u.searchParams.get("webDataId");
      if (id) {
        setWebDataId(id);
        setShowManualWebData(false);
      }
    } catch {
      // ignore
    }
  }, []);

  // 화면 기준 탭: 전체 페이지 warn/fail 항목 오버레이 (스크롤 지도)
  const overlayItems = useMemo(() => {
    if (!resp || !resp.ok) return [];
    const { width: vw } = resp.meta.web.viewport;

    return resp.results
      .filter((r) => {
        if (!r.elementFound || !r.bbox) return false;
        if (r.severity !== "fail" && r.severity !== "warn") return false;
        return r.bbox.x < vw;
      })
      .map((r) => ({ ...r, bbox: r.bbox! }))
      .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  }, [resp]);

  // 텍스트 탭: 전체 or fail/warn
  const textItems = useMemo(() => {
    if (!resp || !resp.ok) return [];
    return showAll ? resp.results : resp.results.filter((r) => r.severity === "fail" || r.severity === "warn");
  }, [resp, showAll]);

  // 화면 기준 탭: bbox 근접 항목을 그룹핑 (지도 오버레이 중복 표시 방지)
  const overlayGroups = useMemo(() => {
    type Group = { items: (typeof overlayItems)[number][]; severity: Severity };
    const groups: Group[] = [];
    const itemToGroup = new Map<string, number>(); // className -> groupIdx

    for (const item of overlayItems) {
      const cx = item.bbox.x + item.bbox.width / 2;
      const cy = item.bbox.y + item.bbox.height / 2;
      const gIdx = groups.findIndex((g) => {
        const rep = g.items[0];
        const gcx = rep.bbox.x + rep.bbox.width / 2;
        const gcy = rep.bbox.y + rep.bbox.height / 2;
        return Math.abs(gcx - cx) < 30 && Math.abs(gcy - cy) < 30;
      });
      if (gIdx >= 0) {
        groups[gIdx].items.push(item);
        if (item.severity === "fail") groups[gIdx].severity = "fail";
        itemToGroup.set(item.className, gIdx);
      } else {
        const newIdx = groups.length;
        groups.push({ items: [item], severity: item.severity });
        itemToGroup.set(item.className, newIdx);
      }
    }
    return { groups, itemToGroup };
  }, [overlayItems]);

  const viewportFromWebData = useMemo(() => {
    if (!resp || !resp.ok) return null;
    const { viewport } = resp.meta.web;
    const scrollHeight = resp.meta.web.scrollHeight ?? viewport.height;
    // 전체 페이지 높이로 지도 표시 (스크롤 가능)
    const displayHeight = Math.max(viewport.height, scrollHeight);
    return {
      width: viewport.width,
      height: displayHeight,
      viewportHeight: viewport.height,
      screenshotTop: 0,
      screenshotHeight: 1,
    };
  }, [resp]);

  useEffect(() => {
    if (!resp || !resp.ok) return;
    if (resultTab !== "screen") return;
    const id = resp.meta.web.webDataId;
    let cancelled = false;
    setScreenshotErr(null);
    setScreenshotUrl(null);
    (async () => {
      try {
        const r = await fetch(`/api/web-data/${encodeURIComponent(id)}/screenshot`, { cache: "no-store" });
        const json = await r.json().catch(() => null);
        if (!r.ok || !json?.ok) {
          throw new Error(json?.error || `screenshot fetch failed (HTTP ${r.status})`);
        }
        if (cancelled) return;

        // Phase 3 합성 완료된 단일 screenshotDataUrl 수신
        if (json.screenshotDataUrl) {
          setScreenshotUrl(String(json.screenshotDataUrl));
          return;
        }
        throw new Error("screenshot 데이터가 없습니다.");
      } catch (e) {
        if (cancelled) return;
        setScreenshotErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resp, resultTab]);

  async function compare() {
    setSelected(null);
    setResp(null);
    setJob(null);
    setRunning(true);
    try {
      const r = await fetch("/api/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webDataId,
          figma: {
            devModeUrlOrFileKey: figmaUrlOrKey,
            personalAccessToken: figmaToken || undefined,
          },
          thresholdPx,
          nodeClassMapping: undefined,
        }),
      });
      const json = (await r.json()) as CompareResponse;
      setResp(json);
      // Feature 3: Save history
      if (json.ok) {
        saveHistory({
          figmaUrlOrKey,
          webDataId,
          viewport: viewportPreset,
          threshold: thresholdPx,
          summary: json.summary,
          fullResponse: json,
        });
      }
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Unknown error";
      setResp({ ok: false, error: msg });
    } finally {
      setRunning(false);
    }
  }

  async function diagnose() {
    // removed
  }

  function reset() {
    setResp(null);
    setJob(null);
    setSelected(null);
  }

  const appOrigin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://127.0.0.1:3022";

  const extractionScript = `(() => {
  // App endpoint (auto-filled from your app origin):
  const ENDPOINT = '${appOrigin}/api/web-data';

  const pickKeys = [
    'width','height',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'marginTop','marginRight','marginBottom','marginLeft',
    'gap',
    'fontSize','fontWeight','lineHeight','letterSpacing',
    'color','backgroundColor','borderRadius','opacity',
    'borderTopWidth','borderTopColor','borderTopStyle',
    'outlineWidth','outlineColor','outlineStyle',
    'transitionDuration','transitionTimingFunction'
  ];
  const paddingKeys = ['paddingTop','paddingRight','paddingBottom','paddingLeft'];
  const TRANSPARENT = 'rgba(0, 0, 0, 0)';

  const elements = {};
  const all = Array.from(document.querySelectorAll('*'));
  for (const el of all) {
    const cls = Array.from(el.classList || []);
    if (!cls.length) continue;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const computed = Object.fromEntries(pickKeys.map(k => [k, String(cs[k] ?? '')]));
    computed._tagName = el.tagName.toLowerCase();

    // 유효 패딩: 자신이 0이면 첫 자식 체인(최대 3단계)에서 찾기
    // → CSS에서 Figma padding을 자식 요소에 구현하는 패턴 처리
    let cur = el;
    for (let d = 0; d < 3; d++) {
      const child = cur.firstElementChild;
      if (!child) break;
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) break;
      const ccs = getComputedStyle(child);
      let updated = false;
      for (const pk of paddingKeys) {
        if (parseFloat(computed[pk]) === 0 && parseFloat(ccs[pk]) > 0) {
          computed[pk] = ccs[pk]; updated = true;
        }
      }
      if (!updated) break; // 자식에서도 0이면 더 깊이 탐색 불필요
      cur = child;
    }

    // 유효 배경색: 투명이면 조상을 타고 올라가서 찾기
    // → 부모 컨테이너에 배경이 있고 자식은 transparent인 패턴 처리
    if (computed.backgroundColor === TRANSPARENT) {
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const bg = getComputedStyle(ancestor).backgroundColor;
        if (bg !== TRANSPARENT) { computed.backgroundColor = bg; break; }
        ancestor = ancestor.parentElement;
      }
    }

    const payload = {
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      classList: cls,
      computed,
    };
    for (const c of cls) {
      if (!elements[c]) elements[c] = payload;
    }
  }

  const data = {
    href: location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
    extractedAt: Date.now(),
    elements,
  };

  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
    .then(r => r.json())
    .then(json => {
      console.log('[Design QA] upload response:', json);
      if (json?.webDataId) {
        console.log('[Design QA] webDataId:', json.webDataId);
        try { navigator.clipboard.writeText(json.webDataId); } catch {}
      }
    })
    .catch(err => console.error('[Design QA] upload failed:', err));
})();`;

  const bookmarkletHref = useMemo(() => {
    const code = `(function(){try{var APP='${appOrigin}';var ENDPOINT=APP+'/api/web-data';var pick=['width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderRadius','opacity','borderTopWidth','borderTopColor','borderTopStyle','outlineWidth','outlineColor','outlineStyle','transitionDuration','transitionTimingFunction'];var pkeys=['paddingTop','paddingRight','paddingBottom','paddingLeft'];var TRANS='rgba(0, 0, 0, 0)';var elements={};var all=Array.prototype.slice.call(document.querySelectorAll('*'));for(var i=0;i<all.length;i++){var el=all[i];var cls=el.classList?Array.prototype.slice.call(el.classList):[];if(!cls.length)continue;var cs=getComputedStyle(el);var r=el.getBoundingClientRect();var computed={};for(var k=0;k<pick.length;k++){computed[pick[k]]=String(cs[pick[k]]||'');}computed._tagName=el.tagName.toLowerCase();var cur=el;for(var d=0;d<3;d++){var child=cur.firstElementChild;if(!child)break;var cr=child.getBoundingClientRect();if(cr.width<=0||cr.height<=0)break;var ccs=getComputedStyle(child);var upd=false;for(var p=0;p<pkeys.length;p++){var pk=pkeys[p];if(parseFloat(computed[pk])===0&&parseFloat(ccs[pk])>0){computed[pk]=ccs[pk];upd=true;}}if(!upd)break;cur=child;}if(computed.backgroundColor===TRANS){var anc=el.parentElement;while(anc&&anc!==document.documentElement){var bg=getComputedStyle(anc).backgroundColor;if(bg!==TRANS){computed.backgroundColor=bg;break;}anc=anc.parentElement;}}var payload={bbox:{x:r.x,y:r.y,width:r.width,height:r.height},classList:cls,computed:computed};for(var j=0;j<cls.length;j++){var c=cls[j];if(!elements[c])elements[c]=payload;}}var data={href:location.href,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1},extractedAt:Date.now(),elements:elements};fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(json){console.log('[Design QA] upload response:',json);if(json&&json.webDataId){try{navigator.clipboard.writeText(json.webDataId);}catch(e){}var u=APP+'/?webDataId='+encodeURIComponent(json.webDataId);window.open(u,'_blank','noopener,noreferrer');}}).catch(function(err){console.error('[Design QA] upload failed:',err);alert('Design QA upload failed: '+(err&&err.message?err.message:err));});}catch(e){console.error(e);alert('Design QA bookmarklet error: '+(e&&e.message?e.message:e));}})();`;
    return `javascript:${encodeURIComponent(code)}`;
  }, [appOrigin]);

  return (
    <main className="container">
      <div className="title">
        <h1 style={{ margin: 0, lineHeight: 1, fontFamily: "-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif", fontWeight: "500", letterSpacing: "-0.03em" }}>
          <span style={{ fontSize: "28px", verticalAlign: "baseline" }}>M</span><span style={{ fontSize: "26px", verticalAlign: "baseline", margin: "0 2px" }}>.</span><span style={{ fontSize: "26px", verticalAlign: "baseline", letterSpacing: "0.02em" }}>zero</span>
        </h1>
      </div>

      <div className="grid">
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <section className="panel">
          <h2 style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6, flexShrink: 0 }}>
              <rect x="1" y="1" width="14" height="14" rx="3" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M4.5 8h7M4.5 5h7M4.5 11h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            Inputs
          </h2>

          <div className="field">
            <div className="label">Figma Dev Mode URL 또는 File Key</div>
            <input
              className="input"
              placeholder="https://www.figma.com/file/<fileKey>/... 또는 fileKey"
              value={figmaUrlOrKey}
              onChange={(e) => setFigmaUrlOrKey(e.target.value)}
            />
          </div>

          <div className="field" style={{ marginTop: 10 }}>
            <div className="label">Figma Personal Access Token</div>
            <input
              className="input"
              placeholder="figd_로 시작하는 Token 값 입력"
              value={figmaToken}
              onChange={(e) => setFigmaToken(e.target.value)}
              type="password"
              autoComplete="off"
            />
          </div>

          <div className="row">
            <div className="field">
              <div className="label">Viewport</div>
              <select
                className="select"
                value={viewportPreset}
                onChange={(e) => setViewportPreset(e.target.value as ViewportPreset)}
              >
                {VIEWPORT_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.options.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <div className="field">
              <div className="label">Threshold (±px)</div>
              <input
                className="input"
                value={Number.isFinite(thresholdPx) ? thresholdPx : 2}
                onChange={(e) => setThresholdPx(Number(e.target.value))}
                type="number"
                min={0}
                step={1}
              />
            </div>
          </div>

          <div className="actionsFull" style={{ marginTop: 4 }}>
            <button className="btn" onClick={compare} disabled={running}>
              {running ? "Comparing..." : "Compare"}
            </button>
            <button className="btnSecondary" onClick={reset} disabled={running}>
              Reset
            </button>
          </div>

          {running && (
            <div className="hint" style={{ marginTop: 10 }}>
              비교 중입니다. (Web Data 업로드가 선행되어야 합니다.)
            </div>
          )}

          <div style={{ marginTop: 8 }}>
            <button
              className="btnLink"
              type="button"
              onClick={() => setShowManualWebData((v) => !v)}
            >
              {showManualWebData ? "▲ manual web-data 숨기기" : "▼ manual web-data 입력"}
            </button>
          </div>

          {showManualWebData && (
            <>
              <div className="field" style={{ marginTop: 14 }}>
                <div className="label">Web Data ID (콘솔 스크립트 실행 후 생성됨)</div>
                <input
                  className="input"
                  placeholder="web_xxx..."
                  value={webDataId}
                  onChange={(e) => setWebDataId(e.target.value)}
                />
              </div>

              <div className="field">
                <div className="label">웹 콘솔에 붙여넣을 CSS 추출 스크립트</div>
                <textarea className="input" style={{ height: 180 }} value={extractionScript} readOnly />
                <div className="actions" style={{ marginTop: 8 }}>
                  <button
                    className="btnSecondary"
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(extractionScript);
                      } catch {}
                    }}
                  >
                    Copy script
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  1) 운영 웹으로 직접 접속 → DevTools Console에 스크립트 실행
                  <br />
                  2) 콘솔에 출력된 <span className="mono">webDataId</span>를 위 입력칸에 붙여넣고 Compare
                </div>
              </div>

              <div className="field">
                <div className="label">Bookmarklet (대체 수단)</div>
                <div className="hint" style={{ marginBottom: 8 }}>
                  아래 링크를 **북마크바로 드래그**한 뒤, 운영 웹에서 클릭하면 자동 업로드 → 새 탭에서 결과 앱이 열립니다.
                </div>
                <a className="btnSecondary" href={bookmarkletHref}>
                  Design QA: Extract & Upload
                </a>
                <div className="actions" style={{ marginTop: 8 }}>
                  <button
                    className="btnSecondary"
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(bookmarkletHref);
                      } catch {}
                    }}
                  >
                    Copy bookmarklet
                  </button>
                </div>
              </div>
            </>
          )}

          {resp && !resp.ok && (
            <div className="error" style={{ marginTop: 12 }}>
              {resp.error}
            </div>
          )}

          {job && (
            <div style={{ marginTop: 12 }}>
              <div className="card">
                <div className="cardTop">
                  <div className="mono">Job</div>
                  <div className="tag">{job.status}</div>
                </div>
                {Array.isArray(job.logs) && job.logs.length > 0 && (
                  <div className="hint mono" style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>
                    {job.logs.slice(-30).map((l: string, i: number) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                )}
                {job.status === "failed" && (
                  <div className="error" style={{ marginTop: 8 }}>
                    {job.response?.stage ? <div className="mono">stage: {job.response.stage}</div> : null}
                    {job.response?.error ?? "failed"}
                  </div>
                )}
              </div>
            </div>
          )}


        </section>

        {/* History panel */}
        {historyEntries.length > 0 && (
          <section className="panel" style={{ marginTop: 8 }}>
            <h2 style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6, flexShrink: 0 }}>
                <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              History
            </h2>
            <div className="historyList" style={{ marginTop: 10 }}>
              {historyEntries.map((e) => (
                <div key={e.id} className="historyItem" onClick={() => {
                  setFigmaUrlOrKey(e.figmaUrlOrKey);
                  setWebDataId(e.webDataId);
                  setViewportPreset(e.viewport as ViewportPreset);
                  setThresholdPx(e.threshold);
                  if (e.fullResponse) setResp(e.fullResponse);
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {e.figmaUrlOrKey.length > 34 ? e.figmaUrlOrKey.slice(0, 34) + "…" : e.figmaUrlOrKey}
                    </div>
                    <div className="historyMeta" style={{ marginTop: 3 }}>
                      <span className="historyBadge">{new Date(e.timestamp).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                      {e.summary.fail > 0 && <span className="historyBadge historyBadgeFail">F:{e.summary.fail}</span>}
                      {e.summary.warn > 0 && <span className="historyBadge historyBadgeWarn">W:{e.summary.warn}</span>}
                      <span className="historyBadge">P:{e.summary.pass}</span>
                      <span className="historyBadge">{e.viewport}px</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(ev) => { ev.stopPropagation(); removeHistory(e.id); }}
                    style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 14, padding: "2px 4px", flexShrink: 0 }}
                    title="삭제"
                  >×</button>
                </div>
              ))}
            </div>
          </section>
        )}
        </div>

        <section className="panel">
          <h2 style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ opacity: 0.6, flexShrink: 0 }}>
              <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M5.5 8.5l2 2 3-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Results
          </h2>

          {!resp && <div className="hint">좌측 입력 후 Compare를 누르면 결과가 표시됩니다.</div>}

          {resp && resp.ok && (
            <div className="results">
              {/* 뷰포트 불일치 경고 */}
              {resp.meta.web.viewport.width !== Number(viewportPreset) && (
                <div style={{
                  background: "rgba(255,169,64,0.08)",
                  border: "1px solid rgba(255,169,64,0.3)",
                  borderRadius: 8,
                  padding: "8px 12px",
                  fontSize: 12,
                  color: "rgba(255,211,105,0.9)",
                  marginBottom: 12,
                }}>
                  ⚠ 캡처된 웹 데이터의 뷰포트({resp.meta.web.viewport.width}px)와 선택된 뷰포트({viewportPreset}px)가 다릅니다. 정확한 비교를 위해 {viewportPreset}px 너비에서 확장 프로그램을 다시 실행해주세요.
                </div>
              )}

              {/* ── Summary 배지 ── */}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
                {resp.summary.fail > 0 && (
                  <span style={{ background: "rgba(255,107,107,0.18)", border: "1px solid rgba(255,107,107,0.4)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "#ff6b6b", fontWeight: 700 }}>
                    🔴 Fail {resp.summary.fail}
                  </span>
                )}
                {resp.summary.warn > 0 && (
                  <span style={{ background: "rgba(255,211,105,0.12)", border: "1px solid rgba(255,211,105,0.3)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "rgba(255,211,105,0.9)", fontWeight: 700 }}>
                    🟡 Warn {resp.summary.warn}
                  </span>
                )}
                {resp.summary.pass > 0 && (
                  <span style={{ background: "rgba(82,196,26,0.1)", border: "1px solid rgba(82,196,26,0.25)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "rgba(100,220,80,0.85)", fontWeight: 700 }}>
                    ✅ Pass {resp.summary.pass}
                  </span>
                )}
              </div>

<div className="tabGroup" style={{ marginBottom: 12 }}>
                <button
                  className={resultTab === "screen" ? "tabBtn tabBtnActive" : "tabBtn"}
                  type="button"
                  onClick={() => setResultTab("screen")}
                >
                  화면 기준
                </button>
                <button
                  className={resultTab === "text" ? "tabBtn tabBtnActive" : "tabBtn"}
                  type="button"
                  onClick={() => setResultTab("text")}
                >
                  텍스트 정보
                </button>
              </div>

              {resultTab === "screen" ? (
                /* ── 화면 기준: 좌(뷰포트 맵) + 우(어노테이션 리스트) ── */
                <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start" }}>

                  {/* ── LEFT: Viewport Map ── */}
                  <div style={{ flex: "0 0 auto", width: "min(340px, 44%)" }}>
                    {viewportFromWebData && (
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 4 }}>
                        {resp.meta.web.viewport.width}px × {resp.meta.web.viewport.height}px
                      </div>
                    )}
                    {viewportFromWebData ? (
                      /* 외부 래퍼: 전체 이미지를 그대로 늘어뜨림 (스크롤 없음) */
                      <div
                        className="viewportMapScroll"
                        style={{
                          width: "100%",
                          borderRadius: 12,
                          border: "1px solid rgba(255,255,255,0.08)",
                          background: "linear-gradient(135deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02))",
                          position: "relative",
                        }}
                      >
                          {/* 전체 페이지 스크린샷: 자연 높이로 쭉 늘어남 */}
                          {screenshotUrl ? (
                            <img
                              src={screenshotUrl}
                              alt="captured page"
                              style={{
                                display: "block",
                                width: "100%",
                                height: "auto",
                                opacity: 0.9,
                                borderRadius: 12,
                              }}
                            />
                          ) : (
                            /* 스크린샷 없을 때 aspect-ratio 플레이스홀더 */
                            <div
                              style={{
                                width: "100%",
                                aspectRatio: `${viewportFromWebData.width} / ${viewportFromWebData.height}`,
                              }}
                            />
                          )}

                        {/* 오버레이 레이어: 이미지 위에 absolute 덮기 */}
                        <div
                          style={{
                            position: "absolute",
                            inset: 0,
                            overflow: "visible",
                          }}
                        >
                          {overlayGroups.groups.map((group, gIdx) => {
                            // 그룹 내 모든 아이템이 skip이면 오버레이 숨김
                            const allSkipped = group.items.every(
                              (item) => annStore[item.className]?.status === "skip"
                            );
                            if (allSkipped) return null;
                            const it = group.items[0]; // representative bbox
                            const count = group.items.length;
                            const scaleX = 100 / viewportFromWebData.width;
                            // viewportFromWebData.height = max(viewport.height, scrollHeight)
                            // scrollHeight는 Phase 4 업로드 시 실제 캡처 높이(lastStrip.scrollY + vpH)로 설정됨
                            const scaleY = 100 / viewportFromWebData.height;
                            // 텍스트 관련 diff가 있고 textBbox가 존재하면
                            // X/폭은 원래 bbox 유지(좌측 잘림 방지), Y/높이만 텍스트 라인으로 좁힘
                            const TEXT_DIFF_KEYS = new Set(["color","fontSize","fontWeight","fontFamily","fontStyle","textDecoration","lineHeight","letterSpacing"]);
                            const hasTextDiff = it.diffs.some((d) => TEXT_DIFF_KEYS.has(d.key));
                            let displayBbox = (hasTextDiff && it.textBbox)
                              ? { x: it.bbox.x, width: it.bbox.width, y: it.textBbox.y, height: it.textBbox.height }
                              : it.bbox;
                            // position:fixed 하단 요소 보정:
                            // fastExtract는 scrollY=0 기준 뷰포트 y를 저장하지만
                            // 스티치 이미지에선 마지막 strip에 그려짐 → y 재계산
                            if (it.fixedPosition === "bottom" && viewportFromWebData) {
                              const vpH = viewportFromWebData.viewportHeight;
                              const scrollH = viewportFromWebData.height;
                              displayBbox = { ...displayBbox, y: scrollH - vpH + displayBbox.y };
                            }
                            // bbox.y는 이미 절대 좌표(scrollY=0 기준)이므로 그대로 사용
                            const rawRight  = displayBbox.x * scaleX + displayBbox.width * scaleX;
                            const rawBottom = displayBbox.y * scaleY + displayBbox.height * scaleY;
                            const left = Math.max(0, Math.min(displayBbox.x * scaleX, 99));
                            const top  = Math.max(0, Math.min(displayBbox.y * scaleY, 99));
                            const w = Math.max(Math.min(rawRight, 100) - left, 0.5);
                            const h = Math.max(Math.min(rawBottom, 100) - top, 0.5);
                            const isSelected = group.items.some((i) => selected?.className === i.className);
                            const color = group.severity === "fail" ? "rgba(255,107,107,0.95)" : "rgba(255,211,105,0.95)";
                            // Badge: place below box if near top edge, above otherwise
                            const badgeOnTop = top > 2;
                            return (
                              <button
                                key={it.className}
                                type="button"
                                onClick={() => setSelected(isSelected ? null : group.items[0])}
                                title={group.items.map((i) => `.${i.className} (${severityToLabel(i.severity)})`).join(", ")}
                                style={{
                                  position: "absolute",
                                  left: `${left}%`,
                                  top: `${top}%`,
                                  width: `${w}%`,
                                  height: `${h}%`,
                                  border: `2px solid ${color}`,
                                  background: isSelected ? color.replace("0.95", "0.22") : "transparent",
                                  borderRadius: 4,
                                  boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
                                  cursor: "pointer",
                                  padding: 0,
                                  zIndex: isSelected ? 2 : 1,
                                  overflow: "visible",
                                }}
                              >
                                {/* 번호 배지: 뷰포트 상단 근처면 아래에, 그 외엔 위에 표시 */}
                                <div
                                  style={{
                                    position: "absolute",
                                    top: badgeOnTop ? -10 : "auto",
                                    bottom: badgeOnTop ? "auto" : -10,
                                    left: -1,
                                    minWidth: 17,
                                    height: 17,
                                    borderRadius: 9,
                                    background: color,
                                    color: group.severity === "fail" ? "#fff" : "#000",
                                    fontSize: 9,
                                    fontWeight: 800,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "0 4px",
                                    pointerEvents: "none",
                                    lineHeight: 1,
                                    boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
                                    zIndex: 10,
                                    gap: 2,
                                  }}
                                >
                                  <span>{gIdx + 1}</span>
                                  {count > 1 && (
                                    <span style={{ opacity: 0.75, fontSize: 8 }}>+{count - 1}</span>
                                  )}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="hint">viewport 정보를 찾지 못했습니다.</div>
                    )}

                    {screenshotErr && (
                      <div className="hint" style={{ marginTop: 8, fontSize: 11 }}>
                        screenshot 없음 — 확장프로그램 새로고침 후 재업로드해주세요.
                      </div>
                    )}

                    <div style={{ marginTop: 8, textAlign: "right" }}>
                      <a className="btnSecondary" href={resp.meta.web.href} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                        운영 화면 열기 ↗
                      </a>
                    </div>
                  </div>

                  {/* ── RIGHT: 어노테이션 리스트 ── */}
                  <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                    {overlayItems.length === 0 ? (
                      <div>
                        {textItems.length === 0 ? (
                          <div className="hint">warn/fail 항목이 없습니다. 🎉</div>
                        ) : (
                          <div className="hint" style={{ lineHeight: 1.8 }}>
                            <span style={{ color: "rgba(255,107,107,0.85)" }}>●</span>{" "}
                            뷰포트에 표시할 항목이 없습니다.<br />
                            <strong style={{ color: "rgba(255,255,255,0.7)" }}>{textItems.length}개</strong>의 warn/fail 항목이 있으나
                            웹에서 클래스를 찾지 못했거나(Missing) 뷰포트 밖에 있습니다.<br />
                            <button
                              type="button"
                              className="btnSecondary"
                              style={{ marginTop: 8, fontSize: 11 }}
                              onClick={() => setResultTab("text")}
                            >
                              텍스트 정보 탭에서 확인 →
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      (() => {
                        // 상태별 그룹핑: 미처리 → 수정완료 → Skip
                        const active  = overlayItems.filter((it) => !annStore[it.className] || annStore[it.className].status === "none");
                        const fixed   = overlayItems.filter((it) => annStore[it.className]?.status === "fixed");
                        const skipped = overlayItems.filter((it) => annStore[it.className]?.status === "skip");

                        function renderCard(it: typeof overlayItems[number]) {
                          const isSelected = selected?.className === it.className;
                          const annStatus = annStore[it.className]?.status ?? "none";
                          const isSkipped = annStatus === "skip";
                          const isFixed   = annStatus === "fixed";
                          const color = it.severity === "fail" ? "rgba(255,107,107,0.95)" : "rgba(255,211,105,0.95)";
                          const failRows = prioritizeRows(it.rows).filter((r) => !r.ok);
                          const passRows = prioritizeRows(it.rows).filter((r) => r.ok);
                          const gIdx = overlayGroups.itemToGroup.get(it.className) ?? 0;
                          const group = overlayGroups.groups[gIdx];
                          const groupCount = group?.items.length ?? 1;
                          const displayNum = gIdx + 1;
                          return (
                            <div
                              key={it.className}
                              className={`card${isSkipped ? " cardSkipped" : isFixed ? " cardFixed" : ""}`}
                              onClick={() => setSelected(isSelected ? null : it)}
                              style={{
                                cursor: "pointer",
                                border: `1px solid ${isSelected ? color : "rgba(255,255,255,0.06)"}`,
                                background: isSelected ? color.replace("0.95", "0.07") : undefined,
                                transition: "border-color 0.15s, background 0.15s",
                                padding: "10px 12px",
                              }}
                            >
                              <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                {/* 번호 배지 */}
                                <div
                                  style={{
                                    flex: "0 0 auto", width: 22, height: 22, borderRadius: 11,
                                    background: isSkipped ? "rgba(255,255,255,0.15)" : isFixed ? "rgba(82,196,26,0.7)" : color,
                                    color: it.severity === "fail" ? "#fff" : "#000",
                                    fontSize: groupCount > 1 ? 9 : 11, fontWeight: 800,
                                    display: "flex", alignItems: "center", justifyContent: "center",
                                    marginTop: 1, flexDirection: "column", lineHeight: 1, gap: 1,
                                  }}
                                >
                                  <span>{displayNum}</span>
                                  {groupCount > 1 && <span style={{ fontSize: 7, opacity: 0.75 }}>{group.items.indexOf(it) + 1}/{groupCount}</span>}
                                </div>

                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                                    <span className="mono" style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      .{it.className}
                                      {it.matchedWebClassName && it.matchedWebClassName !== it.className && (
                                        <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400 }}> → {it.matchedWebClassName}</span>
                                      )}
                                    </span>
                                    <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                                      {isFixed  && <span className="tag tagFixed">수정완료</span>}
                                      {isSkipped && <span className="tag tagSkip">Skip</span>}
                                      <span className={`tag ${it.severity === "warn" ? "tagWarn" : "tagFail"}`}>{severityToLabel(it.severity)}</span>
                                    </div>
                                  </div>

                                  {/* Diff rows */}
                                  {failRows.length > 0 && (
                                    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }}>
                                      {failRows.slice(0, isSelected ? 999 : 4).map((d) => (
                                        <div key={d.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, gap: 8, minWidth: 0 }}>
                                          <span style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0, display: "flex", alignItems: "center", gap: 3 }}>
                                            {d.key}
                                            {d.tokenMismatch && <span style={{ fontSize: 9, background: "rgba(255,193,7,0.25)", color: "#ffc107", borderRadius: 3, padding: "0 3px", fontWeight: 600 }}>토큰↕</span>}
                                          </span>
                                          <span className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, display: "flex", alignItems: "center", gap: 3 }}>
                                            {d.figmaHex && <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: d.figmaHex, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />}
                                            <span style={{ color: "#6ab4ff" }}>{String(d.figma ?? "—")}</span>
                                            <span style={{ color: "rgba(255,255,255,0.3)", margin: "0 2px" }}>→</span>
                                            {d.webHex && <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: d.webHex, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />}
                                            <span style={{ color: "#ff6b6b" }}>{String(d.web ?? "—")}</span>
                                          </span>
                                        </div>
                                      ))}
                                      {!isSelected && failRows.length > 4 && (
                                        <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 1 }}>+{failRows.length - 4}개 더 · 클릭해서 펼치기</div>
                                      )}
                                    </div>
                                  )}

                                  {/* Pass rows (선택 시만) */}
                                  {isSelected && passRows.length > 0 && (
                                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", gap: 3 }}>
                                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginBottom: 2 }}>✅ PASS</div>
                                      {passRows.map((d) => (
                                        <div key={d.key} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, gap: 8 }}>
                                          <span style={{ color: "rgba(255,255,255,0.3)", flexShrink: 0 }}>{d.key}</span>
                                          <span className="mono" style={{ whiteSpace: "nowrap", color: "rgba(100,220,130,0.8)" }}>{String(d.figma ?? "—")}</span>
                                        </div>
                                      ))}
                                    </div>
                                  )}

                                  {/* Annotation actions */}
                                  <AnnotationActions
                                    className={it.className}
                                    ann={annStore[it.className]}
                                    onStatus={(s) => setAnn(it.className, { status: s })}
                                    onComment={(v) => setAnn(it.className, { comment: v })}
                                  />
                                </div>
                              </div>
                            </div>
                          );
                        }

                        return (
                          <>
                            {active.map(renderCard)}
                            {fixed.length > 0 && (
                              <CollapsibleGroup label={`✓ 수정완료 — ${fixed.length}개`} color="rgba(82,196,26,0.7)" defaultOpen={false}>
                                {fixed.map(renderCard)}
                              </CollapsibleGroup>
                            )}
                            {skipped.length > 0 && (
                              <CollapsibleGroup label={`– Skip됨 — ${skipped.length}개`} color="rgba(255,169,64,0.7)" defaultOpen={false}>
                                {skipped.map(renderCard)}
                              </CollapsibleGroup>
                            )}
                          </>
                        );
                      })()
                    )}
                  </div>
                </div>
              ) : (
                /* ── 텍스트 탭 ── */
                <div style={{ marginTop: 12 }}>
                  {/* 전체/오류만 필터 토글 */}
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                    <div style={{ display: "flex", gap: 4, background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: 3, border: "1px solid rgba(255,255,255,0.08)" }}>
                      <button
                        type="button"
                        onClick={() => setShowAll(false)}
                        style={{
                          border: "none", borderRadius: 5, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                          background: !showAll ? "rgba(91,140,255,0.25)" : "transparent",
                          color: !showAll ? "var(--text)" : "rgba(255,255,255,0.4)",
                          transition: "background 0.12s",
                        }}
                      >오류만</button>
                      <button
                        type="button"
                        onClick={() => setShowAll(true)}
                        style={{
                          border: "none", borderRadius: 5, padding: "4px 12px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                          background: showAll ? "rgba(91,140,255,0.25)" : "transparent",
                          color: showAll ? "var(--text)" : "rgba(255,255,255,0.4)",
                          transition: "background 0.12s",
                        }}
                      >전체 보기</button>
                    </div>
                  </div>

                  <div className="reportList">
                    {textItems.length === 0 ? (
                      <div className="hint">항목이 없습니다. 🎉</div>
                    ) : (
                      <>
                        {(() => {
                          const missingItems = textItems.filter((r) => !r.elementFound);
                          const foundItems = textItems.filter((r) => r.elementFound);
                          // Skip/Fixed 항목은 맨 뒤로
                          const sorted = [
                            ...foundItems.filter((r) => !annStore[r.className] || annStore[r.className].status === "none"),
                            ...foundItems.filter((r) => annStore[r.className]?.status === "fixed"),
                            ...foundItems.filter((r) => annStore[r.className]?.status === "skip"),
                          ];
                          return (
                            <>
                              {sorted.map((r, idx) => {
                                const isSelected = selected?.className === r.className;
                                const isPass = r.severity === "pass";
                                const annStatus = annStore[r.className]?.status ?? "none";
                                const isSkipped = annStatus === "skip";
                                const isFixed = annStatus === "fixed";
                                const color = isPass
                                  ? "rgba(82,196,26,0.8)"
                                  : r.severity === "fail"
                                  ? "rgba(255,107,107,0.95)"
                                  : "rgba(255,211,105,0.95)";
                                return (
                                  <div
                                    key={r.className}
                                    className={`card${isSkipped ? " cardSkipped" : isFixed ? " cardFixed" : ""}`}
                                    onClick={() => !isPass && setSelected(isSelected ? null : r)}
                                    style={{
                                      cursor: isPass ? "default" : "pointer",
                                      border: `1px solid ${isSelected ? color : "rgba(255,255,255,0.06)"}`,
                                      background: isSelected ? color.replace("0.95", "0.07") : undefined,
                                    }}
                                  >
                                    <div className="cardTop">
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                        <div
                                          style={{
                                            flex: "0 0 auto", width: 20, height: 20, borderRadius: 10,
                                            background: isSkipped ? "rgba(255,255,255,0.15)" : color,
                                            color: r.severity === "fail" ? "#fff" : "#000",
                                            fontSize: 10, fontWeight: 800,
                                            display: "flex", alignItems: "center", justifyContent: "center",
                                          }}
                                        >
                                          {idx + 1}
                                        </div>
                                        <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          .{r.className}
                                          {r.matchedWebClassName && r.matchedWebClassName !== r.className && (
                                            <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400 }}> → {r.matchedWebClassName}</span>
                                          )}
                                        </div>
                                      </div>
                                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
                                        {isSkipped && <span className="tag tagSkip">Skip</span>}
                                        {isFixed && <span className="tag tagFixed">수정완료</span>}
                                        <div className={`tag ${isPass ? "tagPass" : r.severity === "warn" ? "tagWarn" : "tagFail"}`}>
                                          {isPass ? "PASS" : severityToLabel(r.severity)}
                                        </div>
                                      </div>
                                    </div>
                                    {/* Diff rows (fail/warn only) */}
                                    {!isPass && Array.isArray(r.rows) && r.rows.length > 0 && (
                                      <div className="diffGrid" style={{ marginTop: 10 }}>
                                        <div>
                                          <div className="colTitle">Figma</div>
                                          <div className="kv mono">
                                            {prioritizeRows(r.rows).map((d) => (
                                              <div key={d.key} className={`kvRow${d.ok ? "" : " kvRowFail"}`}>
                                                <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                                                  {d.key}
                                                  {d.tokenMismatch && <span style={{ fontSize: 9, background: "rgba(255,193,7,0.25)", color: "#ffc107", borderRadius: 3, padding: "0 3px", fontWeight: 600 }}>토큰↕</span>}
                                                </div>
                                                <div style={{ color: d.ok ? undefined : "#6ab4ff", display: "flex", alignItems: "center", gap: 3 }}>
                                                  {d.figmaHex && <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: d.figmaHex, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />}
                                                  {String(d.figma ?? "—")}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                        <div>
                                          <div className="colTitle">Web</div>
                                          <div className="kv mono">
                                            {prioritizeRows(r.rows).map((d) => (
                                              <div key={d.key} className={`kvRow${d.ok ? "" : " kvRowFail"}`}>
                                                <div>{d.key}</div>
                                                <div style={{ color: d.ok ? undefined : "#ff6b6b", display: "flex", alignItems: "center", gap: 3 }}>
                                                  {d.webHex && <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: d.webHex, border: "1px solid rgba(255,255,255,0.2)", flexShrink: 0 }} />}
                                                  {String(d.web ?? "—")}
                                                </div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {/* Pass 항목: rows 요약 */}
                                    {isPass && Array.isArray(r.rows) && r.rows.length > 0 && (
                                      <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
                                        {r.rows.slice(0, 6).map((d) => (
                                          <span key={d.key} className="mono historyBadge" style={{ fontSize: 10 }}>{d.key}: {String(d.figma ?? "—")}</span>
                                        ))}
                                        {r.rows.length > 6 && <span className="historyBadge" style={{ fontSize: 10 }}>+{r.rows.length - 6}</span>}
                                      </div>
                                    )}
                                    {/* Skip/Comment actions (pass 항목 포함) */}
                                    <AnnotationActions
                                      className={r.className}
                                      ann={annStore[r.className]}
                                      onStatus={(s) => setAnn(r.className, { status: s })}
                                      onComment={(v) => setAnn(r.className, { comment: v })}
                                    />
                                  </div>
                                );
                              })}

                              {/* Missing 항목 섹션 */}
                              {missingItems.length > 0 && (
                                <MissingSection items={missingItems} foundCount={foundItems.length} />
                              )}
                            </>
                          );
                        })()}
                      </>
                    )}
                  </div>
                </div>
              )}

            </div>
          )}
        </section>
      </div>
    </main>
  );
}

// ────────────────────────────────────────────────────
// Feature 2: Skip / Annotation hook (LocalStorage)
// ────────────────────────────────────────────────────
type AnnStatus = "none" | "skip" | "fixed";
type AnnEntry = { status: AnnStatus; comment: string };
type AnnStore = Record<string, AnnEntry>;

function useAnnotations(fileKey: string | null, nodeId: string | null) {
  const storageKey = fileKey && nodeId ? `dqa_ann_${fileKey}_${nodeId}` : null;
  const [store, setStore] = useState<AnnStore>({});

  useEffect(() => {
    if (!storageKey) { setStore({}); return; }
    try {
      const raw = localStorage.getItem(storageKey);
      // migrate old format: {skip: bool} → {status}
      const parsed = raw ? JSON.parse(raw) : {};
      const migrated: AnnStore = {};
      for (const [k, v] of Object.entries(parsed) as [string, any][]) {
        migrated[k] = {
          status: v.status ?? (v.skip ? "skip" : "none"),
          comment: v.comment ?? "",
        };
      }
      setStore(migrated);
    } catch { setStore({}); }
  }, [storageKey]);

  function setAnn(className: string, patch: Partial<AnnEntry>) {
    if (!storageKey) return;
    setStore((prev) => {
      const base: AnnEntry = prev[className] ?? { status: "none" as AnnStatus, comment: "" };
      const next = { ...prev, [className]: { ...base, ...patch } };
      // Clean up empty entries
      if (next[className].status === "none" && !next[className].comment) delete next[className];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return { store, setAnn };
}

// ────────────────────────────────────────────────────
// Feature 3: History hook (LocalStorage)
// ────────────────────────────────────────────────────
type HistoryEntry = {
  id: string;
  timestamp: number;
  figmaUrlOrKey: string;
  webDataId: string;
  viewport: string;
  threshold: number;
  summary: { total: number; pass: number; warn: number; fail: number; missing: number };
  fullResponse?: CompareResponse;
};

const HISTORY_KEY = "dqa_history";
const HISTORY_MAX = 15;

function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      setEntries(raw ? JSON.parse(raw) : []);
    } catch { setEntries([]); }
  }, []);

  function save(entry: Omit<HistoryEntry, "id" | "timestamp">) {
    setEntries((prev) => {
      const next = [{ ...entry, id: String(Date.now()), timestamp: Date.now() }, ...prev].slice(0, HISTORY_MAX);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  function remove(id: string) {
    setEntries((prev) => {
      const next = prev.filter((e) => e.id !== id);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return { entries, save, remove };
}

// ────────────────────────────────────────────────────
// Annotation card actions (Status + Comment)
// ────────────────────────────────────────────────────
const STATUS_CONFIG: Record<AnnStatus, { label: string; activeColor: string; icon: string }> = {
  none:  { label: "미처리",   activeColor: "rgba(255,255,255,0.35)", icon: "○" },
  fixed: { label: "수정완료", activeColor: "rgba(82,196,26,0.9)",    icon: "✓" },
  skip:  { label: "Skip",     activeColor: "rgba(255,169,64,0.9)",   icon: "–" },
};

function AnnotationActions({
  className,
  ann,
  onStatus,
  onComment,
}: {
  className: string;
  ann: AnnEntry | undefined;
  onStatus: (s: AnnStatus) => void;
  onComment: (v: string) => void;
}) {
  const [showComment, setShowComment] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const status = ann?.status ?? "none";
  const comment = ann?.comment ?? "";

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
        {(["fixed", "skip"] as AnnStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s];
          const isActive = status === s;
          return (
            <button
              key={s}
              type="button"
              className={`btnAnnotation${isActive ? " btnAnnotationActive btnAnnotationCancelable" : ""}`}
              style={isActive ? { color: cfg.activeColor, borderColor: cfg.activeColor.replace("0.9", "0.4"), background: cfg.activeColor.replace("0.9", "0.1") } : {}}
              onClick={() => onStatus(isActive ? "none" : s)}
              title={isActive ? "클릭하면 미처리로 복원" : cfg.label}
            >
              {isActive ? (
                <>
                  <span className="btnAnnNormal">{cfg.icon} {cfg.label} ×</span>
                  <span className="btnAnnHover">↩ 취소</span>
                </>
              ) : (
                <>{cfg.icon} {cfg.label}</>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className={`btnAnnotation${(showComment || comment) ? " btnAnnotationActive" : ""}`}
          onClick={() => {
            setShowComment((v) => !v);
            setTimeout(() => textRef.current?.focus(), 50);
          }}
          title="코멘트 추가"
        >
          💬{comment ? " " + comment.slice(0, 18) + (comment.length > 18 ? "…" : "") : " 메모"}
        </button>
      </div>
      {showComment && (
        <textarea
          ref={textRef}
          className="annotationComment"
          placeholder="의도된 차이, 작업 메모 등을 입력하세요…"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
        />
      )}
    </div>
  );
}

// 상태 그룹 접기/펼치기 컴포넌트
function CollapsibleGroup({ label, color, defaultOpen, children }: {
  label: string; color: string; defaultOpen: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%", textAlign: "left", background: "transparent",
          border: `1px solid ${color.replace("0.7", "0.2")}`,
          borderRadius: 8, padding: "6px 10px", cursor: "pointer",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          color, fontSize: 11, fontWeight: 600,
        }}
      >
        <span>{label}</span>
        <span style={{ opacity: 0.6, fontSize: 10 }}>{open ? "▲ 닫기" : "▼ 펼치기"}</span>
      </button>
      {open && <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>{children}</div>}
    </div>
  );
}

/** "FigmaNode = css-class" 형식 텍스트를 Record로 파싱 */
function parseMappingText(text: string): Record<string, string> | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return undefined;
  const map: Record<string, string> = {};
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    const figmaName = line.slice(0, idx).trim();
    const cssClass = line.slice(idx + 1).trim().replace(/^\./, "");
    if (figmaName && cssClass) map[figmaName] = cssClass;
  }
  return Object.keys(map).length ? map : undefined;
}

function MissingSection({ items, foundCount }: { items: MatchResult[]; foundCount: number }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 4 }}>
      <button
        type="button"
        className="btnSecondary"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", textAlign: "left", padding: "8px 12px", fontSize: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <span>
          <span style={{ color: "rgba(255,107,107,0.9)" }}>●</span>
          {" "}Missing (클래스 미매칭) — {items.length}개
          {foundCount > 0 && <span style={{ color: "rgba(255,255,255,0.35)", marginLeft: 8 }}>Figma 노드명과 CSS 클래스명이 다릅니다</span>}
        </span>
        <span style={{ color: "rgba(255,255,255,0.4)", fontSize: 11 }}>{open ? "▲ 닫기" : "▼ 펼치기"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {items.map((r) => (
            <div
              key={r.className}
              style={{
                padding: "6px 12px",
                background: "rgba(255,107,107,0.05)",
                border: "1px solid rgba(255,107,107,0.15)",
                borderRadius: 6,
                fontSize: 11,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <span className="mono" style={{ color: "rgba(255,255,255,0.6)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                .{r.className}
              </span>
              <span style={{ color: "rgba(255,107,107,0.7)", flexShrink: 0, fontSize: 10 }}>not found</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function prioritizeRows<T extends { key: string }>(rows: T[]): T[] {
  const priority = ["fontSize", "color", "backgroundColor", "lineHeight", "fontWeight"];
  const pr = new Map(priority.map((k, i) => [k, i]));
  return [...rows].sort((a, b) => {
    const pa = pr.has(a.key) ? (pr.get(a.key) as number) : 999;
    const pb = pr.has(b.key) ? (pr.get(b.key) as number) : 999;
    if (pa !== pb) return pa - pb;
    return a.key.localeCompare(b.key);
  });
}

