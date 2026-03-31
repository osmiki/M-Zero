"use client";

import { useState } from "react";
import type { MatchResult } from "../types";

export function MissingSection({ items, foundCount }: { items: MatchResult[]; foundCount: number }) {
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
