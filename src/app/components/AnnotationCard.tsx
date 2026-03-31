"use client";

import type { MatchResult } from "../types";
import { severityToLabel, prioritizeRows, matchMethodLabel, matchMethodColor } from "../types";
import type { AnnStore } from "../hooks/useAnnotations";
import { AnnotationActions } from "./AnnotationActions";

type Props = {
  item: MatchResult;
  index: number;
  /** Group badge count (e.g. "2/3") — screen tab only */
  groupBadge?: { displayNum: number; groupCount: number; posInGroup: number };
  isSelected: boolean;
  onSelect: (item: MatchResult | null) => void;
  annStore: AnnStore;
  setAnn: (className: string, patch: Partial<import("../hooks/useAnnotations").AnnEntry>) => void;
  /** "screen" shows inline diff rows; "text" shows diffGrid columns */
  variant: "screen" | "text";
};

export function AnnotationCard({ item, index, groupBadge, isSelected, onSelect, annStore, setAnn, variant }: Props) {
  const annStatus = annStore[item.className]?.status ?? "none";
  const isSkipped = annStatus === "skip";
  const isFixed = annStatus === "fixed";
  const isPass = item.severity === "pass";
  const color = isPass
    ? "rgba(82,196,26,0.8)"
    : item.severity === "fail"
    ? "rgba(255,107,107,0.95)"
    : "rgba(255,211,105,0.95)";

  const failRows = prioritizeRows(item.rows).filter((r) => !r.ok);
  const passRows = prioritizeRows(item.rows).filter((r) => r.ok);

  const badgeNum = groupBadge?.displayNum ?? index + 1;
  const badgeSize = variant === "screen" ? 22 : 20;

  return (
    <div
      className={`card${isSkipped ? " cardSkipped" : isFixed ? " cardFixed" : ""}`}
      onClick={() => !isPass || variant === "screen" ? onSelect(isSelected ? null : item) : undefined}
      style={{
        cursor: isPass && variant === "text" ? "default" : "pointer",
        border: `1px solid ${isSelected ? color : "rgba(255,255,255,0.06)"}`,
        background: isSelected ? color.replace("0.95", "0.07") : undefined,
        transition: "border-color 0.15s, background 0.15s",
        padding: variant === "screen" ? "10px 12px" : undefined,
      }}
    >
      {variant === "screen" ? (
        /* ── Screen tab card layout ── */
        <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div
            style={{
              flex: "0 0 auto", width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2,
              background: isSkipped ? "rgba(255,255,255,0.15)" : isFixed ? "rgba(82,196,26,0.7)" : color,
              color: item.severity === "fail" ? "#fff" : "#000",
              fontSize: (groupBadge?.groupCount ?? 1) > 1 ? 9 : 11, fontWeight: 800,
              display: "flex", alignItems: "center", justifyContent: "center",
              marginTop: 1, flexDirection: "column", lineHeight: 1, gap: 1,
            }}
          >
            <span>{badgeNum}</span>
            {groupBadge && groupBadge.groupCount > 1 && (
              <span style={{ fontSize: 7, opacity: 0.75 }}>{groupBadge.posInGroup + 1}/{groupBadge.groupCount}</span>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
              <span className="mono" style={{ fontSize: 12, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                .{item.className}
                {item.matchedWebClassName && item.matchedWebClassName !== item.className && (
                  <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400 }}> → {item.matchedWebClassName}</span>
                )}
              </span>
              <div style={{ display: "flex", gap: 4, flexShrink: 0, alignItems: "center" }}>
                {item.matchMethod && (
                  <span style={{
                    fontSize: 9, fontWeight: 600, padding: "1px 5px", borderRadius: 3,
                    background: matchMethodColor(item.matchMethod) + "22",
                    color: matchMethodColor(item.matchMethod),
                    border: `1px solid ${matchMethodColor(item.matchMethod)}44`,
                    whiteSpace: "nowrap",
                  }}>
                    {matchMethodLabel(item.matchMethod, item.matchScore)}
                  </span>
                )}
                {isFixed && <span className="tag tagFixed">수정완료</span>}
                {isSkipped && <span className="tag tagSkip">Skip</span>}
                <span className="tag tagFail">{severityToLabel(item.severity)}</span>
              </div>
            </div>

            {/* Fail diff rows */}
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

            {/* Pass rows (selected only) */}
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

            <AnnotationActions
              className={item.className}
              ann={annStore[item.className]}
              onStatus={(s) => setAnn(item.className, { status: s })}
              onComment={(v) => setAnn(item.className, { comment: v })}
            />
          </div>
        </div>
      ) : (
        /* ── Text tab card layout ── */
        <>
          <div className="cardTop">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <div
                style={{
                  flex: "0 0 auto", width: badgeSize, height: badgeSize, borderRadius: badgeSize / 2,
                  background: isSkipped ? "rgba(255,255,255,0.15)" : color,
                  color: item.severity === "fail" ? "#fff" : "#000",
                  fontSize: 10, fontWeight: 800,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {index + 1}
              </div>
              <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                .{item.className}
                {item.matchedWebClassName && item.matchedWebClassName !== item.className && (
                  <span style={{ color: "rgba(255,255,255,0.35)", fontWeight: 400 }}> → {item.matchedWebClassName}</span>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexShrink: 0 }}>
              {isSkipped && <span className="tag tagSkip">Skip</span>}
              {isFixed && <span className="tag tagFixed">수정완료</span>}
              <div className={`tag ${isPass ? "tagPass" : "tagFail"}`}>
                {isPass ? "PASS" : severityToLabel(item.severity)}
              </div>
            </div>
          </div>

          {/* Diff grid (fail only) */}
          {!isPass && Array.isArray(item.rows) && item.rows.length > 0 && (
            <div className="diffGrid" style={{ marginTop: 10 }}>
              <div>
                <div className="colTitle">Figma</div>
                <div className="kv mono">
                  {prioritizeRows(item.rows).map((d) => (
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
                  {prioritizeRows(item.rows).map((d) => (
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

          {/* Pass summary */}
          {isPass && Array.isArray(item.rows) && item.rows.length > 0 && (
            <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {item.rows.slice(0, 6).map((d) => (
                <span key={d.key} className="mono historyBadge" style={{ fontSize: 10 }}>{d.key}: {String(d.figma ?? "—")}</span>
              ))}
              {item.rows.length > 6 && <span className="historyBadge" style={{ fontSize: 10 }}>+{item.rows.length - 6}</span>}
            </div>
          )}

          <AnnotationActions
            className={item.className}
            ann={annStore[item.className]}
            onStatus={(s) => setAnn(item.className, { status: s })}
            onComment={(v) => setAnn(item.className, { comment: v })}
          />
        </>
      )}
    </div>
  );
}
