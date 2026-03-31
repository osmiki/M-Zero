"use client";

import { useEffect, useState } from "react";

export type AnnStatus = "none" | "skip" | "fixed";
export type AnnEntry = { status: AnnStatus; comment: string };
export type AnnStore = Record<string, AnnEntry>;

export function useAnnotations(fileKey: string | null, nodeId: string | null) {
  const storageKey = fileKey && nodeId ? `dqa_ann_${fileKey}_${nodeId}` : null;
  const [store, setStore] = useState<AnnStore>({});

  useEffect(() => {
    if (!storageKey) { setStore({}); return; }
    try {
      const raw = localStorage.getItem(storageKey);
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
      if (next[className].status === "none" && !next[className].comment) delete next[className];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return { store, setAnn };
}
