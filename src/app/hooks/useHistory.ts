"use client";

import { useEffect, useState } from "react";
import type { CompareResponse } from "../types";

export type HistoryEntry = {
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

export function useHistory() {
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
