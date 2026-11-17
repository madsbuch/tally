import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** How far the indicator has to come down (after resistance) to refresh. */
export const PULL_THRESHOLD = 64;
/** The furthest it comes. */
const PULL_MAX = 96;
/** Indicator travel per pixel of finger travel. */
const RESISTANCE = 0.5;
/** Movement before the gesture counts as a pull or as something else. */
const SLOP = 6;
/** The spinner stays at least this long, so a quick refresh still reads. */
const MIN_SPIN_MS = 600;

/** Where the indicator sits for a given finger travel. */
export function pullDistance(fingerDy: number): number {
  return Math.min(PULL_MAX, Math.max(0, fingerDy * RESISTANCE));
}

/**
 * Pull down at the top of the page to refresh. Touch only — a phone, or a
 * touchscreen; with a mouse the computer syncs every few seconds anyway.
 *
 * A pull starts only at the very top of `scroller`, mostly downward, not in
 * a text field and not while a sheet is open; anything else is left to the
 * page. The indicator follows the finger (with resistance), and letting go
 * past the threshold runs `onRefresh` with a spinner until it's done.
 */
export default function PullToRefresh({
  scroller,
  onRefresh,
}: {
  scroller: RefObject<HTMLElement | null>;
  onRefresh: () => Promise<void>;
}) {
  const indicator = useRef<HTMLDivElement | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let pull = 0;
    let tracking = false;
    let pulling = false;

    const place = (d: number, animate: boolean) => {
      const i = indicator.current;
      if (!i) return;
      i.style.transition = animate ? "" : "none";
      i.style.setProperty("--pull", String(d));
      i.style.setProperty("--progress", String(Math.min(1, d / PULL_THRESHOLD)));
      i.classList.toggle("ptr-armed", d >= PULL_THRESHOLD);
    };

    const onStart = (e: TouchEvent) => {
      tracking = false;
      pulling = false;
      if (busy.current || e.touches.length !== 1 || el.scrollTop > 0) return;
      if (document.querySelector(".sheet-backdrop")) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      const t = e.touches[0];
      if (!t) return;
      startX = t.clientX;
      startY = t.clientY;
      pull = 0;
      tracking = true;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (!pulling) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // Up, sideways, or no longer at the top: not ours.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || el.scrollTop > 0) {
          tracking = false;
          return;
        }
        pulling = true;
      }
      pull = pullDistance(dy);
      // The page stays put while the indicator comes down.
      if (e.cancelable) e.preventDefault();
      place(pull, false);
    };

    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!pulling) return;
      pulling = false;
      if (pull < PULL_THRESHOLD) {
        place(0, true);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      place(PULL_THRESHOLD, true);
      const started = Date.now();
      void refresh
        .current()
        .catch((err) => console.warn("Refresh failed", err))
        .then(() => new Promise((r) => setTimeout(r, Math.max(0, MIN_SPIN_MS - (Date.now() - started)))))
        .then(() => {
          place(0, true);
          setRefreshing(false);
          busy.current = false;
        });
    };

    const onCancel = () => {
      if (!tracking) return;
      tracking = false;
      pulling = false;
      place(0, true);
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
    };
  }, [scroller]);

  return (
    <>
      <div ref={indicator} className={`ptr${refreshing ? " ptr-refreshing" : ""}`} aria-hidden="true">
        <svg className="ptr-icon" viewBox="0 0 24 24">
          <circle className="ptr-arc" cx="12" cy="12" r="8" />
        </svg>
      </div>
      {refreshing && (
        <span className="visually-hidden" role="status">
          Refreshing
        </span>
      )}
    </>
  );
}
