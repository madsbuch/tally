/**
 * Where every screen lives, and the one way of getting to it.
 *
 * What's on screen is the URL's to say — which tab, which entry, which
 * conversation — so anything that wants to show you something (the tab bar, a
 * banner, a chip in a coach message, a notification tapped with the app
 * closed) asks for an address and gets there the same way.
 *
 * Each tab holds a stack: the tab, the pages you went into from it, then any
 * open sheets. Back pops — to the page you came from, whichever tab's address
 * it has — and back from a tab leaves the app. `go` keeps it that shape:
 *
 * - into a page: push it onto the stack you're in, even when its address is
 *   another tab's. A meal opened from a coach message is on the Coach's stack,
 *   and back returns to the conversation;
 * - into a page that's already on the stack: pop back to it, so a chain of
 *   links (chat → meal → that chat) can't grow loops;
 * - to a tab (the tab bar), or with `{ jump: true }` (a notification tapped,
 *   the tab bar returning to an open conversation): unwind to the first
 *   entry, put the target's tab there, and push the page on top if there is
 *   one — so it has its tab beneath it, as if opened by hand;
 * - with `{ replace: true }` (a redirect: the page you're on was deleted):
 *   pop back to it if it's on the stack, else take the current page's place.
 *
 * The stack rides in each history entry's state (`StackState`), so the
 * Android back button and a reload see it as `go` left it.
 */
import { useCallback } from "react";
import { generatePath, useLocation, useNavigate } from "react-router-dom";
import type { Path } from "../router";
import { fieldsOf, isOneOf } from "./guards";
import { closeSheets, pageIndex, rewindPages, unwindHistory } from "./sheetHistory";
import { parseRowId } from "./ids";

/** The tab bar's destinations. */
export const TAB_ROOTS = [
  "/",
  "/nutrients",
  "/body",
  "/assistant",
  "/settings",
] as const satisfies readonly Path[];

export type TabRoot = (typeof TAB_ROOTS)[number];

/**
 * The tab an address belongs to: its first segment, since every page lives
 * under its tab — except the Diary's entries, the Diary being "/". Anything
 * unknown is the Diary's too, which is where the 404 route sends it. Which
 * tab you're *in* is the stack's (`useCurrentTab`): a meal opened from the
 * Coach has the Diary's address but is on the Coach's stack.
 */
export function tabOf(path: string): TabRoot {
  const root = `/${path.split("/")[1] ?? ""}`;
  return TAB_ROOTS.find((t) => t === root) ?? "/";
}

const CHAT_ROUTE = "/assistant/:chatId" satisfies Path;

/** A coach conversation's address. */
export function chatPath(chatId: string): string {
  return generatePath(CHAT_ROUTE, { chatId: String(chatId) });
}

/** The chat id in a `:chatId` param, or null when it isn't one. */
export function parseChatId(raw: string | undefined): string | null {
  return parseRowId(raw, "chat");
}

/** The conversation a path shows, or null when it shows anything else. */
export function chatIdOf(path: string): string | null {
  const [, tab, raw] = path.split("/");
  return tab === "assistant" ? parseChatId(raw) : null;
}

/**
 * Away this long, the conversation you left open isn't where you are any
 * more: coming back, the Coach tab starts from its list — and anything the
 * coach has sent since — rather than yesterday's thread.
 */
export const STALE_CHAT_MS = 30 * 60_000;

/**
 * The stack a history entry is on: the tab it started from, and the pages
 * beneath this one, tab first. A tab's own entry has none beneath it.
 */
export interface StackState {
  tab: TabRoot;
  trail: string[];
}

/**
 * The stack of the entry at `path` with history state `state` (React Router's
 * `location.state`). An entry `go` didn't make — the app's first, a deep URL
 * — is on its address's tab, with nothing beneath it.
 */
export function stackOf(state: unknown, path: string): StackState {
  const fields = fieldsOf(state);
  const tab = fields?.["tab"];
  const trail = fields?.["trail"];
  if (isOneOf(TAB_ROOTS, tab) && Array.isArray(trail) && trail.every((p) => typeof p === "string")) {
    return { tab, trail: trail.filter((p): p is string => typeof p === "string") };
  }
  return { tab: tabOf(path), trail: [] };
}

function currentStack(): StackState {
  // React Router keeps its `location.state` in the history entry's `usr`.
  const entry: unknown = window.history.state;
  return stackOf(fieldsOf(entry)?.["usr"], window.location.pathname);
}

/** The tab the screen you're on belongs to — the one the tab bar lights up. */
export function useCurrentTab(): TabRoot {
  const location = useLocation();
  const state: unknown = location.state;
  return stackOf(state, location.pathname).tab;
}

type Navigate = ReturnType<typeof useNavigate>;

/** How `go` moves; see the header. */
export interface GoOptions {
  jump?: boolean;
  replace?: boolean;
}

/**
 * Navigations run one after another: an unwind has to land before the next
 * one looks at where we are, and two arriving together — a notification tap
 * and the resume it caused — mustn't interleave.
 */
let queue: Promise<void> = Promise.resolve();

/** `go(path)`: show `path`, keeping the history in its one shape. */
export function useGo(): (to: string, opts?: GoOptions) => void {
  const navigate = useNavigate();
  return useCallback(
    (to: string, opts: GoOptions = {}) => {
      queue = queue
        .then(() => goNow(navigate, to, opts))
        .catch((e) => console.warn("Navigation failed", e));
    },
    [navigate],
  );
}

/**
 * A page's ‹ Back: to the page beneath it on its stack — wherever you came
 * from. A page with nothing beneath it (a deep URL) goes to `parent`, the
 * page it usually sits on, or else its tab, rather than leaving the app.
 */
export function useUp(parent?: string): () => void {
  const go = useGo();
  return useCallback(() => {
    const { tab, trail } = currentStack();
    const beneath = trail[trail.length - 1];
    if (beneath !== undefined) go(beneath);
    else if (parent !== undefined && parent !== window.location.pathname) go(parent, { replace: true });
    else go(tab);
  }, [go, parent]);
}

/**
 * What a page's ‹ Back is called: where it goes. `usual` is the page's own
 * word for its usual way back ("Chats", "Manuals"), used when that's where
 * it goes; anywhere else is named by `placeName`.
 */
export function useUpLabel(usual: string, parent?: string): string {
  const location = useLocation();
  const state: unknown = location.state;
  const pathname = location.pathname;
  const { tab, trail } = stackOf(state, pathname);
  const target = trail[trail.length - 1] ?? parent ?? tab;
  return target === (parent ?? tabOf(pathname)) ? usual : placeName(target);
}

/** A short name for what's at an address, for a ‹ Back to it. */
export function placeName(path: string): string {
  const [, first, second, third] = path.split("/");
  if (first === "entry") {
    const kinds: Record<string, string> = {
      meal: "Meal",
      workout: "Workout",
      supplement: "Supplement",
      sleep: "Sleep",
      state: "Observation",
      reading: "Reading",
      performance: "Performance",
    };
    return kinds[second ?? ""] ?? "Entry";
  }
  if (first === "assistant") {
    if (second === undefined || second === "") return "Coach";
    if (second === "manuals") return third ? "Manual" : "Manuals";
    if (second === "experiments") return third ? "Experiment" : "Experiments";
    if (second === "library") return "Library";
    if (second === "memory") return "Memory";
    return "Chat";
  }
  if (first === "nutrients") return second === "progress" ? "Progress" : "Summary";
  if (first === "body") return "Body";
  if (first === "settings") {
    if (second === "sync") return "Sync";
    if (second === "costs") return "Costs";
    return "Settings";
  }
  return "Diary";
}

function settled(step: (then: () => void) => void): Promise<void> {
  return new Promise((resolve) => step(resolve));
}

async function goNow(navigate: Navigate, to: string, opts: GoOptions): Promise<void> {
  const here = window.location.pathname;
  if (to === here) return;
  const { tab, trail } = currentStack();

  if (isOneOf(TAB_ROOTS, to) || opts.jump) {
    // React Router doesn't see the unwind land, so each branch ends by
    // telling it where the history now is.
    await settled(unwindHistory);
    const root = tabOf(to);
    if (to === root) {
      await navigate(root, { replace: true });
      return;
    }
    // The tab goes underneath without being shown on the way — rendering it
    // would run its page for nothing — then the page on top. React Router
    // reads the URL again when a back lands on that entry, so it shows the
    // tab then. The state is in React Router's shape: it counts depth by `idx`.
    window.history.replaceState({ usr: null, key: newKey(), idx: pageIndex() }, "", root);
    await navigate(to, { state: stack(root, [root]) });
    return;
  }

  // Already on this stack: back to it, rather than a second copy on top.
  const at = trail.lastIndexOf(to);
  if (at !== -1) {
    await settled((then) => rewindPages(trail.length - at, then));
    await navigate(to, { replace: true, state: at === 0 ? null : stack(tab, trail.slice(0, at)) });
    return;
  }

  await settled(closeSheets);
  if (opts.replace) {
    await navigate(to, { replace: true, state: trail.length === 0 ? null : stack(tab, trail) });
  } else {
    await navigate(to, { state: stack(tab, [...trail, here]) });
  }
}

function stack(tab: TabRoot, trail: string[]): StackState {
  return { tab, trail };
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}
