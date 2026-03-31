"use client";

import { useRef, useEffect } from "react";
import type { MatchResult, Severity } from "../types";
import { severityToLabel } from "../types";
import type { AnnStore } from "../hooks/useAnnotations";
import { AnnotationCard } from "./AnnotationCard";
import { CollapsibleGroup } from "./CollapsibleGroup";


type OverlayItem = MatchResult & { bbox: { x: number; y: number; width: number; height: number } };
type OverlayGroup = { items: OverlayItem[]; severity: Severity };

type Props = {
  resp: Extract<import("../types").CompareResponse, { ok: true }>;
  overlayItems: OverlayItem[];
  overlayGroups: { groups: OverlayGroup[]; itemToGroup: Map<string, number> };
  viewportFromWebData: { width: number; height: number; viewportHeight: number } | null;
  screenshotUrl: string | null;
  screenshotErr: string | null;
  textItems: MatchResult[];
  selected: MatchResult | null;
  setSelected: (item: MatchResult | null) => void;
  setResultTab: (tab: "screen" | "text") => void;
  annStore: AnnStore;
  setAnn: (className: string, patch: Partial<import("../hooks/useAnnotations").AnnEntry>) => void;
};

export function ScreenTabView({
  resp, overlayItems, overlayGroups, viewportFromWebData,
  screenshotUrl, screenshotErr, textItems,
  selected, setSelected, setResultTab,
  annStore, setAnn,
}: Props) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const selectedMarkerRef = useRef<HTMLButtonElement>(null);



  useEffect(() => {
    if (selected && selectedMarkerRef.current && scrollContainerRef.current) {
      selectedMarkerRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [selected]);

  return (
    <div style={{ display: "flex", gap: 16, marginTop: 12, alignItems: "flex-start" }}>
      {/* LEFT: Viewport Map */}
      <div style={{ flex: "0 0 auto", width: "min(375px, 48%)" }}>
        {viewportFromWebData && (
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", marginBottom: 4 }}>
            {resp.meta.web.viewport.width}px × {viewportFromWebData.height}px
          </div>
        )}
        {viewportFromWebData ? (
          <div
            ref={scrollContainerRef}
            className="viewportMapScroll"
            style={{
              width: "100%", height: "70vh", overflowY: "auto", borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.1)",
              background: "#000",
            }}
          >
            <div style={{ position: "relative" }}>
              {screenshotUrl ? (
                <img src={screenshotUrl} alt="captured page" style={{ display: "block", width: "100%", height: "auto" }} />
              ) : (
                <div style={{ width: "100%", aspectRatio: `${viewportFromWebData.width} / ${viewportFromWebData.height}` }} />
              )}

              {/* CSS compare markers */}
              {(() => {
                const scaleX = 100 / viewportFromWebData.width;
                const scaleY = 100 / viewportFromWebData.height;
                return (
                <div style={{ position: "absolute", inset: 0, overflow: "visible" }}>
                  {overlayGroups.groups.map((group, gIdx) => {
                    const allSkipped = group.items.every((item) => annStore[item.className]?.status === "skip");
                    if (allSkipped) return null;
                    const it = group.items[0];
                    const count = group.items.length;
                    const TEXT_DIFF_KEYS = new Set(["color","fontSize","fontWeight","fontFamily","fontStyle","textDecoration","lineHeight","letterSpacing"]);
                    const hasTextDiff = it.diffs.some((d) => TEXT_DIFF_KEYS.has(d.key));
                    let displayBbox = (hasTextDiff && it.textBbox)
                      ? { x: it.bbox.x, width: it.bbox.width, y: it.textBbox.y, height: it.textBbox.height }
                      : it.bbox;
                    if (it.fixedPosition === "bottom") {
                      const vpH = viewportFromWebData.viewportHeight;
                      const scrollH = viewportFromWebData.height;
                      displayBbox = { ...displayBbox, y: scrollH - vpH + displayBbox.y };
                    }
                    const rawRight = displayBbox.x * scaleX + displayBbox.width * scaleX;
                    const rawBottom = displayBbox.y * scaleY + displayBbox.height * scaleY;
                    const left = Math.max(0, Math.min(displayBbox.x * scaleX, 99));
                    const top = Math.max(0, Math.min(displayBbox.y * scaleY, 99));
                    const w = Math.max(Math.min(rawRight, 100) - left, 0.5);
                    const h = Math.max(Math.min(rawBottom, 100) - top, 0.5);
                    const isSelected = group.items.some((i) => selected?.className === i.className);
                    const color = group.severity === "fail" ? "rgba(255,107,107,0.95)" : "rgba(255,211,105,0.95)";

                    // childBboxes가 있으면 자식 요소들을 각각 박스로 표시
                    const childBboxes = it.childBboxes && it.childBboxes.length > 0 ? it.childBboxes : null;

                    if (childBboxes) {
                      return (
                        <div key={it.className} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
                          {childBboxes.map((cb, cbIdx) => {
                            let cbBox = cb;
                            if (it.fixedPosition === "bottom") {
                              const vpH = viewportFromWebData.viewportHeight;
                              const scrollH = viewportFromWebData.height;
                              cbBox = { ...cb, y: scrollH - vpH + cb.y };
                            }
                            const rawR = cbBox.x * scaleX + cbBox.width * scaleX;
                            const rawB = cbBox.y * scaleY + cbBox.height * scaleY;
                            const cl = Math.max(0, Math.min(cbBox.x * scaleX, 99));
                            const ct = Math.max(0, Math.min(cbBox.y * scaleY, 99));
                            const cw = Math.max(Math.min(rawR, 100) - cl, 0.5);
                            const ch = Math.max(Math.min(rawB, 100) - ct, 0.5);
                            const badgeOnTop = ct > 2;
                            return (
                              <button
                                key={`${it.className}-child-${cbIdx}`}
                                ref={cbIdx === 0 && isSelected ? selectedMarkerRef : undefined}
                                type="button"
                                onClick={() => setSelected(isSelected ? null : group.items[0])}
                                title={group.items.map((i) => `.${i.className} (${severityToLabel(i.severity)})`).join(", ")}
                                style={{
                                  position: "absolute", left: `${cl}%`, top: `${ct}%`, width: `${cw}%`, height: `${ch}%`,
                                  border: `2px solid ${color}`, background: isSelected ? color.replace("0.95", "0.22") : "transparent",
                                  borderRadius: 3, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)", cursor: "pointer", padding: 0,
                                  zIndex: isSelected ? 2 : 1, overflow: "visible", pointerEvents: "auto",
                                }}
                              >
                                {cbIdx === 0 && (
                                  <div style={{
                                    position: "absolute", top: badgeOnTop ? -10 : "auto", bottom: badgeOnTop ? "auto" : -10, left: -1,
                                    minWidth: 17, height: 17, borderRadius: 9, background: color,
                                    color: group.severity === "fail" ? "#fff" : "#000",
                                    fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                                    padding: "0 4px", pointerEvents: "none", lineHeight: 1, boxShadow: "0 1px 4px rgba(0,0,0,0.5)", zIndex: 10, gap: 2,
                                  }}>
                                    <span>{gIdx + 1}</span>
                                    {count > 1 && <span style={{ opacity: 0.75, fontSize: 8 }}>+{count - 1}</span>}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      );
                    }

                    // childBboxes 없음 → 기존 엄마 컴포넌트 bbox로 박스 표시
                    const badgeOnTop = top > 2;
                    return (
                      <button
                        key={it.className}
                        ref={isSelected ? selectedMarkerRef : undefined}
                        type="button"
                        onClick={() => setSelected(isSelected ? null : group.items[0])}
                        title={group.items.map((i) => `.${i.className} (${severityToLabel(i.severity)})`).join(", ")}
                        style={{
                          position: "absolute", left: `${left}%`, top: `${top}%`, width: `${w}%`, height: `${h}%`,
                          border: `2px solid ${color}`, background: isSelected ? color.replace("0.95", "0.22") : "transparent",
                          borderRadius: 4, boxShadow: "0 0 0 1px rgba(0,0,0,0.4)", cursor: "pointer", padding: 0,
                          zIndex: isSelected ? 2 : 1, overflow: "visible",
                        }}
                      >
                        <div style={{
                          position: "absolute", top: badgeOnTop ? -10 : "auto", bottom: badgeOnTop ? "auto" : -10, left: -1,
                          minWidth: 17, height: 17, borderRadius: 9, background: color,
                          color: group.severity === "fail" ? "#fff" : "#000",
                          fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center",
                          padding: "0 4px", pointerEvents: "none", lineHeight: 1, boxShadow: "0 1px 4px rgba(0,0,0,0.5)", zIndex: 10, gap: 2,
                        }}>
                          <span>{gIdx + 1}</span>
                          {count > 1 && <span style={{ opacity: 0.75, fontSize: 8 }}>+{count - 1}</span>}
                        </div>
                      </button>
                    );
                  })}
                </div>
                );
              })()}

            </div>
          </div>
        ) : (
          <div className="hint">viewport 정보를 찾지 못했습니다.</div>
        )}

        {screenshotErr && (
          <div className="hint" style={{ marginTop: 8, fontSize: 11 }}>screenshot 없음 — 확장프로그램 새로고침 후 재업로드해주세요.</div>
        )}

        <div style={{ marginTop: 8, textAlign: "right" }}>
          <a className="btnSecondary" href={resp.meta.web.href} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>운영 화면 열기 ↗</a>
        </div>
      </div>

      {/* RIGHT: Annotation list */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {(
          /* CSS compare annotations */
          overlayItems.length === 0 ? (
            <div>
              {textItems.length === 0 ? (
                <div className="hint">fail 항목이 없습니다. 🎉</div>
              ) : (
                <div className="hint" style={{ lineHeight: 1.8 }}>
                  <span style={{ color: "rgba(255,107,107,0.85)" }}>●</span>{" "}
                  뷰포트에 표시할 항목이 없습니다.<br />
                  <strong style={{ color: "rgba(255,255,255,0.7)" }}>{textItems.length}개</strong>의 fail 항목이 있으나
                  웹에서 클래스를 찾지 못했거나(Missing) 뷰포트 밖에 있습니다.<br />
                  <button type="button" className="btnSecondary" style={{ marginTop: 8, fontSize: 11 }} onClick={() => setResultTab("text")}>
                    텍스트 정보 탭에서 확인 →
                  </button>
                </div>
              )}
            </div>
          ) : (
            (() => {
              const active = overlayItems.filter((it) => !annStore[it.className] || annStore[it.className].status === "none");
              const fixed = overlayItems.filter((it) => annStore[it.className]?.status === "fixed");
              const skipped = overlayItems.filter((it) => annStore[it.className]?.status === "skip");
              return (
                <>
                  {active.map((it) => {
                    const gIdx = overlayGroups.itemToGroup.get(it.className) ?? 0;
                    const group = overlayGroups.groups[gIdx];
                    return (
                      <AnnotationCard key={it.className} item={it} index={gIdx}
                        groupBadge={{ displayNum: gIdx + 1, groupCount: group?.items.length ?? 1, posInGroup: group?.items.indexOf(it) ?? 0 }}
                        isSelected={selected?.className === it.className} onSelect={setSelected}
                        annStore={annStore} setAnn={setAnn} variant="screen" />
                    );
                  })}
                  {fixed.length > 0 && (
                    <CollapsibleGroup label={`✓ 수정완료 — ${fixed.length}개`} color="rgba(82,196,26,0.7)" defaultOpen={false}>
                      {fixed.map((it) => {
                        const gIdx = overlayGroups.itemToGroup.get(it.className) ?? 0;
                        const group = overlayGroups.groups[gIdx];
                        return (
                          <AnnotationCard key={it.className} item={it} index={gIdx}
                            groupBadge={{ displayNum: gIdx + 1, groupCount: group?.items.length ?? 1, posInGroup: group?.items.indexOf(it) ?? 0 }}
                            isSelected={selected?.className === it.className} onSelect={setSelected}
                            annStore={annStore} setAnn={setAnn} variant="screen" />
                        );
                      })}
                    </CollapsibleGroup>
                  )}
                  {skipped.length > 0 && (
                    <CollapsibleGroup label={`– Skip됨 — ${skipped.length}개`} color="rgba(255,169,64,0.7)" defaultOpen={false}>
                      {skipped.map((it) => {
                        const gIdx = overlayGroups.itemToGroup.get(it.className) ?? 0;
                        const group = overlayGroups.groups[gIdx];
                        return (
                          <AnnotationCard key={it.className} item={it} index={gIdx}
                            groupBadge={{ displayNum: gIdx + 1, groupCount: group?.items.length ?? 1, posInGroup: group?.items.indexOf(it) ?? 0 }}
                            isSelected={selected?.className === it.className} onSelect={setSelected}
                            annStore={annStore} setAnn={setAnn} variant="screen" />
                        );
                      })}
                    </CollapsibleGroup>
                  )}
                </>
              );
            })()
          )
        )}
      </div>
    </div>
  );
}
