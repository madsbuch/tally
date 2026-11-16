import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { answerConfirm, currentConfirm, subscribeConfirm } from "../lib/confirm";
import type { ConfirmRequest } from "../lib/confirm";
import { useSheetHistory } from "../lib/sheetHistory";

function ConfirmSheet({ req }: { req: ConfirmRequest }) {
  // Android's back button means "no", as it closes any other sheet.
  useSheetHistory(true, () => answerConfirm(false));
  return createPortal(
    <div className="sheet-backdrop" onClick={() => answerConfirm(false)}>
      <div
        className="sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label={req.message}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") answerConfirm(false);
        }}
      >
        <div className="sheet-handle" />
        <p style={{ margin: "4px 0 18px", whiteSpace: "pre-line" }}>{req.message}</p>
        <div className="btn-row" style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => answerConfirm(false)}>
            {req.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`}
            autoFocus
            onClick={() => answerConfirm(true)}
          >
            {req.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Shows whatever `confirmAction` is asking. Mounted once, in _app. */
export default function ConfirmHost() {
  const req = useSyncExternalStore(subscribeConfirm, currentConfirm);
  return req ? <ConfirmSheet key={req.message} req={req} /> : null;
}
