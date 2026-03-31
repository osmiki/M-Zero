"use client";

import type { CompareResponse, MatchResult, Severity } from "../types";
import type { AnnStore } from "../hooks/useAnnotations";
import { ScreenTabView } from "./ScreenTabView";
import { TextTabView } from "./TextTabView";

type OverlayItem = MatchResult & { bbox: { x: number; y: number; width: number; height: number } };
type OverlayGroup = { items: OverlayItem[]; severity: Severity };

type Props = {
  resp: CompareResponse | null;
  selected: MatchResult | null;
  setSelected: (item: MatchResult | null) => void;
  resultTab: "screen" | "text";
  setResultTab: (tab: "screen" | "text") => void;
  screenshotUrl: string | null;
  screenshotErr: string | null;
  overlayItems: OverlayItem[];
  overlayGroups: { groups: OverlayGroup[]; itemToGroup: Map<string, number> };
  viewportFromWebData: { width: number; height: number; viewportHeight: number } | null;
  textItems: MatchResult[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  annStore: AnnStore;
  setAnn: (className: string, patch: Partial<import("../hooks/useAnnotations").AnnEntry>) => void;
};

export function ResultsPanel({
  resp, selected, setSelected, resultTab, setResultTab,
  screenshotUrl, screenshotErr,
  overlayItems, overlayGroups, viewportFromWebData,
  textItems, showAll, setShowAll,
  annStore, setAnn,
}: Props) {
  return (
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

          {/* Summary badges */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12, alignItems: "center" }}>
            {resp.summary.fail > 0 && (
              <span style={{ background: "rgba(255,107,107,0.18)", border: "1px solid rgba(255,107,107,0.4)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "#ff6b6b", fontWeight: 700 }}>
                🔴 Fail {resp.summary.fail}
              </span>
            )}
            {resp.summary.pass > 0 && (
              <span style={{ background: "rgba(82,196,26,0.1)", border: "1px solid rgba(82,196,26,0.25)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "rgba(100,220,80,0.85)", fontWeight: 700 }}>
                ✅ Pass {resp.summary.pass}
              </span>
            )}
            {resp.summary.missing > 0 && (
              <span style={{ background: "rgba(255,169,64,0.08)", border: "1px solid rgba(255,169,64,0.3)", borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "rgba(255,211,105,0.9)", fontWeight: 700 }}>
                ⚠ Missing {resp.summary.missing}
              </span>
            )}
            <span style={{ borderRadius: 6, padding: "2px 8px", fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
              Total {resp.summary.total}
            </span>
          </div>

          {/* Tab switcher */}
          <div className="tabGroup" style={{ marginBottom: 12 }}>
            <button className={resultTab === "screen" ? "tabBtn tabBtnActive" : "tabBtn"} type="button" onClick={() => setResultTab("screen")}>화면 기준</button>
            <button className={resultTab === "text" ? "tabBtn tabBtnActive" : "tabBtn"} type="button" onClick={() => setResultTab("text")}>텍스트 정보</button>
          </div>

          {resultTab === "screen" ? (
            <ScreenTabView
              resp={resp}
              overlayItems={overlayItems}
              overlayGroups={overlayGroups}
              viewportFromWebData={viewportFromWebData}
              screenshotUrl={screenshotUrl}
              screenshotErr={screenshotErr}
              textItems={textItems}
              selected={selected}
              setSelected={setSelected}
              setResultTab={setResultTab}
              annStore={annStore}
              setAnn={setAnn}
            />
          ) : (
            <TextTabView
              textItems={textItems}
              showAll={showAll}
              setShowAll={setShowAll}
              selected={selected}
              setSelected={setSelected}
              annStore={annStore}
              setAnn={setAnn}
            />
          )}
        </div>
      )}
    </section>
  );
}
