"use client";

import type { MatchResult } from "../types";
import type { AnnStore } from "../hooks/useAnnotations";
import { AnnotationCard } from "./AnnotationCard";
import { MissingSection } from "./MissingSection";

type Props = {
  textItems: MatchResult[];
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  selected: MatchResult | null;
  setSelected: (item: MatchResult | null) => void;
  annStore: AnnStore;
  setAnn: (className: string, patch: Partial<import("../hooks/useAnnotations").AnnEntry>) => void;
};

export function TextTabView({ textItems, showAll, setShowAll, selected, setSelected, annStore, setAnn }: Props) {
  return (
    <div style={{ marginTop: 12 }}>
      {/* Filter toggle */}
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
          (() => {
            const missingItems = textItems.filter((r) => !r.elementFound);
            const foundItems = textItems.filter((r) => r.elementFound);
            const sorted = [
              ...foundItems.filter((r) => !annStore[r.className] || annStore[r.className].status === "none"),
              ...foundItems.filter((r) => annStore[r.className]?.status === "fixed"),
              ...foundItems.filter((r) => annStore[r.className]?.status === "skip"),
            ];
            return (
              <>
                {sorted.map((r, idx) => (
                  <AnnotationCard
                    key={r.className}
                    item={r}
                    index={idx}
                    isSelected={selected?.className === r.className}
                    onSelect={setSelected}
                    annStore={annStore}
                    setAnn={setAnn}
                    variant="text"
                  />
                ))}
                {missingItems.length > 0 && (
                  <MissingSection items={missingItems} foundCount={foundItems.length} />
                )}
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}
