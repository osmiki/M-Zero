"use client";

import { useEffect, useMemo, useState } from "react";
import type { ViewportPreset, CompareResponse, MatchResult, Severity } from "./types";
import { VIEWPORTS } from "./types";
import { useAnnotations } from "./hooks/useAnnotations";
import { useHistory } from "./hooks/useHistory";
import type { HistoryEntry } from "./hooks/useHistory";
import { InputPanel } from "./components/InputPanel";
import { ResultsPanel } from "./components/ResultsPanel";

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
  const [showAll, setShowAll] = useState(true);
  const [serverTokenConfigured, setServerTokenConfigured] = useState(false);
  const [nodeClassMappingRaw, setNodeClassMappingRaw] = useState("");
  const [libraryFileKey, setLibraryFileKey] = useState("ixP77xguW48OLFKZBpyLZx");

  // Annotations
  const figmaFileKey = resp && resp.ok ? resp.meta.figma.fileKey : null;
  const figmaNodeId = resp && resp.ok ? resp.meta.figma.nodeId : null;
  const { store: annStore, setAnn } = useAnnotations(figmaFileKey, figmaNodeId);

  // History
  const { entries: historyEntries, save: saveHistory, remove: removeHistory } = useHistory();

  // Check server token status on mount
  useEffect(() => {
    fetch("/api/auth/token-status")
      .then((r) => r.json())
      .then((json) => { if (json?.configured) setServerTokenConfigured(true); })
      .catch(() => {});
  }, []);

  // Parse webDataId from URL
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const id = u.searchParams.get("webDataId");
      if (id) {
        setWebDataId(id);
        setShowManualWebData(false);
      }
    } catch {}
  }, []);

  // Overlay items for screen tab
  const overlayItems = useMemo(() => {
    if (!resp || !resp.ok) return [];
    const { width: vw } = resp.meta.web.viewport;
    return resp.results
      .filter((r) => {
        if (!r.elementFound || !r.bbox || r.bbox!.x >= vw) return false;
        // fail + warn 표시 (pass는 마커 없음)
        if (r.severity !== "fail" && r.severity !== "warn") return false;
        return true;
      })
      .map((r) => ({ ...r, bbox: r.bbox! }))
      .sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
  }, [resp]);

  // Text tab items
  const textItems = useMemo(() => {
    if (!resp || !resp.ok) return [];
    return showAll ? resp.results : resp.results.filter((r) => r.severity === "fail");
  }, [resp, showAll]);

  // Each overlay item is its own group (no grouping)
  const overlayGroups = useMemo(() => {
    type Group = { items: (typeof overlayItems)[number][]; severity: Severity };
    const groups: Group[] = [];
    const itemToGroup = new Map<string, number>();
    for (const item of overlayItems) {
      const idx = groups.length;
      groups.push({ items: [item], severity: item.severity });
      itemToGroup.set(item.className, idx);
    }
    return { groups, itemToGroup };
  }, [overlayItems]);

  // Viewport from web data
  const viewportFromWebData = useMemo(() => {
    if (!resp || !resp.ok) return null;
    const { viewport } = resp.meta.web;
    const scrollHeight = resp.meta.web.scrollHeight ?? viewport.height;
    const displayHeight = Math.max(viewport.height, scrollHeight);
    return { width: viewport.width, height: displayHeight, viewportHeight: viewport.height };
  }, [resp]);

  // Fetch screenshot
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
        if (!r.ok || !json?.ok) throw new Error(json?.error || `screenshot fetch failed (HTTP ${r.status})`);
        if (cancelled) return;
        if (json.screenshotDataUrl) { setScreenshotUrl(String(json.screenshotDataUrl)); return; }
        throw new Error("screenshot 데이터가 없습니다.");
      } catch (e) {
        if (cancelled) return;
        setScreenshotErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
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
          figma: { devModeUrlOrFileKey: figmaUrlOrKey, personalAccessToken: figmaToken || undefined },
          thresholdPx,
          libraryFileKey: libraryFileKey.trim() || undefined,
        }),
      });
      const json = (await r.json()) as CompareResponse;
      setResp(json);
      if (json.ok) {
        saveHistory({ figmaUrlOrKey, webDataId, viewport: viewportPreset, threshold: thresholdPx, summary: json.summary, fullResponse: json });
      }
    } catch (e) {
      setResp({ ok: false, error: e instanceof Error ? e.message : "Unknown error" });
    } finally {
      setRunning(false);
    }
  }

  function reset() {
    setResp(null);
    setJob(null);
    setSelected(null);
  }

  function handleHistoryClick(e: HistoryEntry) {
    setFigmaUrlOrKey(e.figmaUrlOrKey);
    setWebDataId(e.webDataId);
    setViewportPreset(e.viewport as ViewportPreset);
    setThresholdPx(e.threshold);
    if (e.fullResponse) setResp(e.fullResponse);
  }

  return (
    <main className="container">
      <div className="title">
        <h1 style={{ margin: 0, lineHeight: 1 }}>
          <img src="/logo.svg" alt="M·ZER0" style={{ height: "24px", display: "block", marginLeft: "4px" }} />
        </h1>
      </div>

      <div className="grid">
        <InputPanel
          figmaUrlOrKey={figmaUrlOrKey} setFigmaUrlOrKey={setFigmaUrlOrKey}
          libraryFileKey={libraryFileKey} setLibraryFileKey={setLibraryFileKey}
          figmaToken={figmaToken} setFigmaToken={setFigmaToken}
          serverTokenConfigured={serverTokenConfigured}
          viewportPreset={viewportPreset} setViewportPreset={setViewportPreset}
          thresholdPx={thresholdPx} setThresholdPx={setThresholdPx}
          webDataId={webDataId} setWebDataId={setWebDataId}
          showManualWebData={showManualWebData} setShowManualWebData={setShowManualWebData}
          running={running} onCompare={compare} onReset={reset}
          resp={resp} job={job}
          historyEntries={historyEntries} onHistoryClick={handleHistoryClick} onHistoryRemove={removeHistory}
        />

        <ResultsPanel
          resp={resp} selected={selected} setSelected={setSelected}
          resultTab={resultTab} setResultTab={setResultTab}
          screenshotUrl={screenshotUrl} screenshotErr={screenshotErr}
          overlayItems={overlayItems} overlayGroups={overlayGroups} viewportFromWebData={viewportFromWebData}
          textItems={textItems} showAll={showAll} setShowAll={setShowAll}
          annStore={annStore} setAnn={setAnn}
        />
      </div>
    </main>
  );
}
