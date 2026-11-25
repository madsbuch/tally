import type { ReactNode } from "react";
import { useUp, useUpLabel } from "../lib/navigation";

// Spec: SET-1
/** One of Settings' folders: its settings on a page of their own, with the way back. */
export default function SettingsFolder({ title, children }: { title: string; children: ReactNode }) {
  const up = useUp();
  const upLabel = useUpLabel("Settings");
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">{title}</h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ {upLabel}
        </button>
      </header>
      {children}
    </div>
  );
}
