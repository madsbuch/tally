/**
 * Light / dark appearance.
 *
 * The palette lives in App.css as tokens. `data-theme="light" | "dark"` on
 * <html> picks one: the pinned theme from Settings, or — following the system
 * — whichever the phone is in. Android's WebView can't be trusted to answer
 * `prefers-color-scheme` (it only says dark when the app theme declares it,
 * and never updates while the app runs), so there MainActivity is asked
 * directly and announces changes with a `tally:system-theme` event. The media
 * query in App.css only covers the moment before this script runs, and
 * browsers.
 *
 * The choice is kept in localStorage rather than the settings table: it has to
 * be known synchronously, before the first paint, or the app flashes the wrong
 * colours while SQLite opens. It's a per-device preference anyway.
 *
 * Android draws its own status/navigation bar icons; the page tells
 * MainActivity which way they should go through the `TallyTheme` bridge, so a
 * pinned dark theme on a light phone doesn't end up with dark icons on dark.
 *
 * A switch is animated where the WebView can (View Transitions): picked in
 * Settings, the new theme grows out of the button pressed; following the
 * system, it fades in. With reduced motion asked for, it just switches.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "tally.theme";
const PREFS: readonly ThemePref[] = ["system", "light", "dark"];

/** Surfaces the WebView can't paint itself: matches --bg in each theme. */
const BG = { light: "#f3f5ee", dark: "#141a16" } as const;

declare global {
  interface Window {
    /** Injected by MainActivity on Android; absent elsewhere. */
    TallyTheme?: { setDark(dark: boolean): void; isSystemDark?(): boolean };
  }
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return PREFS.find((p) => p === v) ?? "system";
  } catch {
    return "system";
  }
}

/** The phone's dark mode: Android's own answer where there is one. */
function systemDark(): boolean {
  try {
    const native = window.TallyTheme?.isSystemDark?.();
    if (typeof native === "boolean") return native;
  } catch {
    // Fall back to the media query.
  }
  return darkQuery()?.matches ?? false;
}

function resolved(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return systemDark() ? "dark" : "light";
}

/** A point on screen, in CSS pixels from the top left. */
export interface Origin {
  x: number;
  y: number;
}

/** How long the reveal from a pressed button takes. */
const REVEAL_MS = 480;

/** Counts switches, so only the latest one tidies up after itself. */
let switches = 0;

function animatable(): boolean {
  return (
    "startViewTransition" in document &&
    !(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)
  );
}

/**
 * Switch to `pref`'s theme: animated when it changes what's on screen and
 * motion is welcome — grown from `from` when given, faded in otherwise.
 */
function apply(pref: ThemePref, from?: Origin): void {
  const mode = resolved(pref);
  const root = document.documentElement;
  const before = root.getAttribute("data-theme");
  const n = ++switches;
  // The first one (before anything is drawn) and one that changes nothing
  // just set it.
  if (before === null || before === mode || !animatable()) {
    root.classList.remove("theme-reveal");
    paint(mode);
    setBars(mode);
    return;
  }
  root.classList.toggle("theme-reveal", from !== undefined);
  const transition = document.startViewTransition(() => paint(mode));
  if (from) {
    void transition.ready
      .then(() => {
        // Out to the farthest corner, so the circle ends covering it all.
        const r = Math.hypot(
          Math.max(from.x, window.innerWidth - from.x),
          Math.max(from.y, window.innerHeight - from.y),
        );
        root.animate(
          {
            clipPath: [
              `circle(0px at ${from.x}px ${from.y}px)`,
              `circle(${r}px at ${from.x}px ${from.y}px)`,
            ],
          },
          {
            duration: REVEAL_MS,
            easing: "cubic-bezier(0.4, 0, 0.2, 1)",
            pseudoElement: "::view-transition-new(root)",
          },
        );
      })
      .catch(() => {
        // Skipped (another switch overtook it): the theme is applied anyway.
      });
  }
  // The system bars follow once the page has: switched at the start, their
  // icons would sit on the old colours for the length of the animation.
  void transition.finished
    .catch(() => {})
    .then(() => {
      if (n !== switches) return; // a later switch has it now
      root.classList.remove("theme-reveal");
      setBars(mode);
    });
}

/** The page's colours. */
function paint(mode: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", mode);

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = BG[mode];
}

/** Android's status and navigation bar icons. */
function setBars(mode: "light" | "dark"): void {
  try {
    window.TallyTheme?.setDark(mode === "dark");
  } catch {
    // The bridge is best-effort; the page itself is already themed.
  }
}

const listeners = new Set<() => void>();

/**
 * Pick a theme (Settings → General). `from` is where it was picked — the
 * middle of the button — for the new theme to grow from.
 */
export function setThemePref(pref: ThemePref, from?: Origin): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    // Storage unavailable: still switch for this session.
  }
  current = pref;
  apply(pref, from);
  listeners.forEach((l) => l());
}

let current: ThemePref = "system";

/** For useSyncExternalStore in the Settings picker. */
export function subscribeThemePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentThemePref(): ThemePref {
  return current;
}

/** Call once, before React renders. */
export function installTheme(): void {
  current = getThemePref();
  apply(current);
  // Following the system: re-theme when it flips — Android says so itself,
  // a browser through the media query.
  const follow = () => {
    if (current === "system") apply(current);
  };
  darkQuery()?.addEventListener("change", follow);
  window.addEventListener("tally:system-theme", follow);
  // Back from the background: the phone may have switched while the app was
  // away and the event been missed.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") follow();
  });
}
