// A minimal app for tests/browser/navigation.check.cjs: the real navigation
// and sheet-history code, stub pages at the app's real addresses.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { useCurrentTab, useGo, useUp, useUpLabel, type GoOptions } from "../../src/lib/navigation";
import { useSheetHistory } from "../../src/lib/sheetHistory";

declare global {
  interface Window {
    nav?: { go: (to: string, opts?: GoOptions) => void; up: () => void; openSheet: () => void };
  }
}

function parentOf(path: string): string | undefined {
  if (/^\/assistant\/manuals\/[^/]+$/.test(path)) return "/assistant/manuals";
  if (/^\/assistant\/experiments\/[^/]+$/.test(path)) return "/assistant/experiments";
  return undefined;
}

function Shell() {
  const location = useLocation();
  const go = useGo();
  const parent = parentOf(location.pathname);
  const up = useUp(parent);
  const label = useUpLabel("usual", parent);
  const tab = useCurrentTab();
  const [sheet, setSheet] = useState(false);
  useSheetHistory(sheet, () => setSheet(false));
  window.nav = { go, up, openSheet: () => setSheet(true) };
  return (
    <div>
      <div id="path">{location.pathname}</div>
      <div id="tab">{tab}</div>
      <div id="label">{label}</div>
      <div id="sheet">{sheet ? "open" : "closed"}</div>
      <Outlet />
    </div>
  );
}

const router = createBrowserRouter([{ path: "*", element: <Shell /> }]);
const root = document.getElementById("root");
if (!root) throw new Error("no #root");
createRoot(root).render(<RouterProvider router={router} />);
