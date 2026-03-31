"use client";

import { useState } from "react";

export function CollapsibleGroup({ label, color, defaultOpen, children }: {
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
