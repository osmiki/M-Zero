"use client";

import { useRef, useState } from "react";
import type { AnnEntry, AnnStatus } from "../hooks/useAnnotations";

const STATUS_CONFIG: Record<AnnStatus, { label: string; activeColor: string; icon: string }> = {
  none:  { label: "미처리",   activeColor: "rgba(255,255,255,0.35)", icon: "○" },
  fixed: { label: "수정완료", activeColor: "rgba(82,196,26,0.9)",    icon: "✓" },
  skip:  { label: "Skip",     activeColor: "rgba(255,169,64,0.9)",   icon: "–" },
};

export function AnnotationActions({
  className,
  ann,
  onStatus,
  onComment,
}: {
  className: string;
  ann: AnnEntry | undefined;
  onStatus: (s: AnnStatus) => void;
  onComment: (v: string) => void;
}) {
  const [showComment, setShowComment] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const status = ann?.status ?? "none";
  const comment = ann?.comment ?? "";

  return (
    <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 8 }}>
      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
        {(["fixed", "skip"] as AnnStatus[]).map((s) => {
          const cfg = STATUS_CONFIG[s];
          const isActive = status === s;
          return (
            <button
              key={s}
              type="button"
              className={`btnAnnotation${isActive ? " btnAnnotationActive btnAnnotationCancelable" : ""}`}
              style={isActive ? { color: cfg.activeColor, borderColor: cfg.activeColor.replace("0.9", "0.4"), background: cfg.activeColor.replace("0.9", "0.1") } : {}}
              onClick={() => onStatus(isActive ? "none" : s)}
              title={isActive ? "클릭하면 미처리로 복원" : cfg.label}
            >
              {isActive ? (
                <>
                  <span className="btnAnnNormal">{cfg.icon} {cfg.label} ×</span>
                  <span className="btnAnnHover">↩ 취소</span>
                </>
              ) : (
                <>{cfg.icon} {cfg.label}</>
              )}
            </button>
          );
        })}
        <button
          type="button"
          className={`btnAnnotation${(showComment || comment) ? " btnAnnotationActive" : ""}`}
          onClick={() => {
            setShowComment((v) => !v);
            setTimeout(() => textRef.current?.focus(), 50);
          }}
          title="코멘트 추가"
        >
          💬{comment ? " " + comment.slice(0, 18) + (comment.length > 18 ? "…" : "") : " 메모"}
        </button>
      </div>
      {showComment && (
        <textarea
          ref={textRef}
          className="annotationComment"
          placeholder="의도된 차이, 작업 메모 등을 입력하세요…"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
        />
      )}
    </div>
  );
}
