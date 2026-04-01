"use client";

import { useMemo } from "react";
import type { ViewportPreset, CompareResponse } from "../types";
import { VIEWPORT_GROUPS } from "../types";
import type { HistoryEntry } from "../hooks/useHistory";

type Props = {
  figmaUrlOrKey: string;
  setFigmaUrlOrKey: (v: string) => void;
  libraryFileKey: string;
  setLibraryFileKey: (v: string) => void;
  figmaToken: string;
  setFigmaToken: (v: string) => void;
  serverTokenConfigured: boolean;
  viewportPreset: ViewportPreset;
  setViewportPreset: (v: ViewportPreset) => void;
  thresholdPx: number;
  setThresholdPx: (v: number) => void;
  webDataId: string;
  setWebDataId: (v: string) => void;
  showManualWebData: boolean;
  setShowManualWebData: (v: boolean) => void;
  running: boolean;
  onCompare: () => void;
  onReset: () => void;
  resp: CompareResponse | null;
  job: any | null;
  historyEntries: HistoryEntry[];
  onHistoryClick: (e: HistoryEntry) => void;
  onHistoryRemove: (id: string) => void;
};

export function InputPanel({
  figmaUrlOrKey, setFigmaUrlOrKey,
  libraryFileKey, setLibraryFileKey,
  figmaToken, setFigmaToken,
  serverTokenConfigured,
  viewportPreset, setViewportPreset,
  thresholdPx, setThresholdPx,
  webDataId, setWebDataId,
  showManualWebData, setShowManualWebData,
  running, onCompare, onReset,
  resp, job,
  historyEntries, onHistoryClick, onHistoryRemove,
}: Props) {
  const appOrigin =
    typeof window !== "undefined" && window.location?.origin ? window.location.origin : "http://127.0.0.1:3022";

  const extractionScript = `(() => {
  const ENDPOINT = '${appOrigin}/api/web-data';
  const pickKeys = ['width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderRadius','opacity','borderTopWidth','borderTopColor','borderTopStyle','outlineWidth','outlineColor','outlineStyle','transitionDuration','transitionTimingFunction'];
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
    let cur = el;
    for (let d = 0; d < 3; d++) {
      const child = cur.firstElementChild;
      if (!child) break;
      const cr = child.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) break;
      const ccs = getComputedStyle(child);
      let updated = false;
      for (const pk of paddingKeys) {
        if (parseFloat(computed[pk]) === 0 && parseFloat(ccs[pk]) > 0) { computed[pk] = ccs[pk]; updated = true; }
      }
      if (!updated) break;
      cur = child;
    }
    if (computed.backgroundColor === TRANSPARENT) {
      let ancestor = el.parentElement;
      while (ancestor && ancestor !== document.documentElement) {
        const bg = getComputedStyle(ancestor).backgroundColor;
        if (bg !== TRANSPARENT) { computed.backgroundColor = bg; break; }
        ancestor = ancestor.parentElement;
      }
    }
    const payload = { bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, classList: cls, computed };
    for (const c of cls) { if (!elements[c]) elements[c] = payload; }
  }
  const data = { href: location.href, viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 }, extractedAt: Date.now(), elements };
  fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    .then(r => r.json())
    .then(json => { console.log('[Design QA] upload response:', json); if (json?.webDataId) { try { navigator.clipboard.writeText(json.webDataId); } catch {} } })
    .catch(err => console.error('[Design QA] upload failed:', err));
})();`;

  const bookmarkletHref = useMemo(() => {
    const code = `(function(){try{var APP='${appOrigin}';var ENDPOINT=APP+'/api/web-data';var pick=['width','height','paddingTop','paddingRight','paddingBottom','paddingLeft','marginTop','marginRight','marginBottom','marginLeft','gap','fontSize','fontWeight','lineHeight','letterSpacing','color','backgroundColor','borderRadius','opacity','borderTopWidth','borderTopColor','borderTopStyle','outlineWidth','outlineColor','outlineStyle','transitionDuration','transitionTimingFunction'];var pkeys=['paddingTop','paddingRight','paddingBottom','paddingLeft'];var TRANS='rgba(0, 0, 0, 0)';var elements={};var all=Array.prototype.slice.call(document.querySelectorAll('*'));for(var i=0;i<all.length;i++){var el=all[i];var cls=el.classList?Array.prototype.slice.call(el.classList):[];if(!cls.length)continue;var cs=getComputedStyle(el);var r=el.getBoundingClientRect();var computed={};for(var k=0;k<pick.length;k++){computed[pick[k]]=String(cs[pick[k]]||'');}computed._tagName=el.tagName.toLowerCase();var cur=el;for(var d=0;d<3;d++){var child=cur.firstElementChild;if(!child)break;var cr=child.getBoundingClientRect();if(cr.width<=0||cr.height<=0)break;var ccs=getComputedStyle(child);var upd=false;for(var p=0;p<pkeys.length;p++){var pk=pkeys[p];if(parseFloat(computed[pk])===0&&parseFloat(ccs[pk])>0){computed[pk]=ccs[pk];upd=true;}}if(!upd)break;cur=child;}if(computed.backgroundColor===TRANS){var anc=el.parentElement;while(anc&&anc!==document.documentElement){var bg=getComputedStyle(anc).backgroundColor;if(bg!==TRANS){computed.backgroundColor=bg;break;}anc=anc.parentElement;}}var payload={bbox:{x:r.x,y:r.y,width:r.width,height:r.height},classList:cls,computed:computed};for(var j=0;j<cls.length;j++){var c=cls[j];if(!elements[c])elements[c]=payload;}}var data={href:location.href,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:window.devicePixelRatio||1},extractedAt:Date.now(),elements:elements};fetch(ENDPOINT,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();}).then(function(json){console.log('[Design QA] upload response:',json);if(json&&json.webDataId){try{navigator.clipboard.writeText(json.webDataId);}catch(e){}var u=APP+'/?webDataId='+encodeURIComponent(json.webDataId);window.open(u,'_blank','noopener,noreferrer');}}).catch(function(err){console.error('[Design QA] upload failed:',err);alert('Design QA upload failed: '+(err&&err.message?err.message:err));});}catch(e){console.error(e);alert('Design QA bookmarklet error: '+(e&&e.message?e.message:e));}})();`;
    return `javascript:${encodeURIComponent(code)}`;
  }, [appOrigin]);

  return (
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
          <input className="input" placeholder="https://www.figma.com/file/<fileKey>/... 또는 fileKey" value={figmaUrlOrKey} onChange={(e) => setFigmaUrlOrKey(e.target.value)} />
        </div>

        <div className="field" style={{ marginTop: 8 }}>
          <div className="label" style={{ color: "rgba(255,255,255,0.45)" }}>디자인 시스템 라이브러리 File Key <span style={{ fontSize: 10, opacity: 0.6 }}>(색상 토큰명 표시용, 선택)</span></div>
          <input className="input" placeholder="ixP77xguW48OLFKZBpyLZx" value={libraryFileKey} onChange={(e) => setLibraryFileKey(e.target.value)} />
        </div>

        {serverTokenConfigured ? (
          <div className="field" style={{ marginTop: 10 }}>
            <div className="label" style={{ color: "rgba(82,196,26,0.8)" }}>Server token configured</div>
          </div>
        ) : (
          <div className="field" style={{ marginTop: 10 }}>
            <div className="label">Figma Personal Access Token</div>
            <input className="input" placeholder="figd_로 시작하는 Token 값 입력" value={figmaToken} onChange={(e) => setFigmaToken(e.target.value)} type="password" autoComplete="off" />
          </div>
        )}

        <div className="row">
          <div className="field">
            <div className="label">Viewport</div>
            <select className="select" value={viewportPreset} onChange={(e) => setViewportPreset(e.target.value as ViewportPreset)}>
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
            <input className="input" value={Number.isFinite(thresholdPx) ? thresholdPx : 2} onChange={(e) => setThresholdPx(Number(e.target.value))} type="number" min={0} step={1} />
          </div>
        </div>

        <div className="actionsFull" style={{ marginTop: 4 }}>
          <button className="btn" onClick={onCompare} disabled={running}>{running ? "Comparing..." : "Compare"}</button>
          <button className="btnSecondary" onClick={onReset} disabled={running}>Reset</button>
        </div>

        {running && <div className="hint" style={{ marginTop: 10 }}>비교 중입니다. (Web Data 업로드가 선행되어야 합니다.)</div>}

        <div style={{ marginTop: 8 }}>
          <button className="btnLink" type="button" onClick={() => setShowManualWebData(!showManualWebData)}>
            {showManualWebData ? "▲ manual web-data 숨기기" : "▼ manual web-data 입력"}
          </button>
        </div>

        {showManualWebData && (
          <>
            <div className="field" style={{ marginTop: 14 }}>
              <div className="label">Web Data ID (콘솔 스크립트 실행 후 생성됨)</div>
              <input className="input" placeholder="web_xxx..." value={webDataId} onChange={(e) => setWebDataId(e.target.value)} />
            </div>
            <div className="field">
              <div className="label">웹 콘솔에 붙여넣을 CSS 추출 스크립트</div>
              <textarea className="input" style={{ height: 180 }} value={extractionScript} readOnly />
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="btnSecondary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(extractionScript); } catch {} }}>Copy script</button>
              </div>
              <div className="hint" style={{ marginTop: 8 }}>
                1) 운영 웹으로 직접 접속 → DevTools Console에 스크립트 실행<br />
                2) 콘솔에 출력된 <span className="mono">webDataId</span>를 위 입력칸에 붙여넣고 Compare
              </div>
            </div>
            <div className="field">
              <div className="label">Bookmarklet (대체 수단)</div>
              <div className="hint" style={{ marginBottom: 8 }}>아래 링크를 **북마크바로 드래그**한 뒤, 운영 웹에서 클릭하면 자동 업로드 → 새 탭에서 결과 앱이 열립니다.</div>
              <a className="btnSecondary" href={bookmarkletHref}>Design QA: Extract & Upload</a>
              <div className="actions" style={{ marginTop: 8 }}>
                <button className="btnSecondary" type="button" onClick={async () => { try { await navigator.clipboard.writeText(bookmarkletHref); } catch {} }}>Copy bookmarklet</button>
              </div>
            </div>
          </>
        )}

        {resp && !resp.ok && <div className="error" style={{ marginTop: 12 }}>{resp.error}</div>}

        {job && (
          <div style={{ marginTop: 12 }}>
            <div className="card">
              <div className="cardTop">
                <div className="mono">Job</div>
                <div className="tag">{job.status}</div>
              </div>
              {Array.isArray(job.logs) && job.logs.length > 0 && (
                <div className="hint mono" style={{ marginTop: 8, maxHeight: 180, overflow: "auto" }}>
                  {job.logs.slice(-30).map((l: string, i: number) => <div key={i}>{l}</div>)}
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
              <div key={e.id} className="historyItem" onClick={() => onHistoryClick(e)}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="mono" style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.figmaUrlOrKey.length > 34 ? e.figmaUrlOrKey.slice(0, 34) + "…" : e.figmaUrlOrKey}
                  </div>
                  <div className="historyMeta" style={{ marginTop: 3 }}>
                    <span className="historyBadge">{new Date(e.timestamp).toLocaleDateString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                    {e.summary.fail > 0 && <span className="historyBadge historyBadgeFail">F:{e.summary.fail}</span>}
                    <span className="historyBadge">P:{e.summary.pass}</span>
                    <span className="historyBadge">{e.viewport}px</span>
                  </div>
                </div>
                <button type="button" onClick={(ev) => { ev.stopPropagation(); onHistoryRemove(e.id); }} style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.3)", cursor: "pointer", fontSize: 14, padding: "2px 4px", flexShrink: 0 }} title="삭제">×</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
