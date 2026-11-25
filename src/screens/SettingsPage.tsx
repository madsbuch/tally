import { Link } from "react-router-dom";
import SyncLink from "../components/SyncLink";

/** A folder on Settings, and what it holds. */
interface Folder {
  path: string;
  title: string;
  holds: string;
}

const isAndroid = navigator.userAgent.includes("Android");

// Spec: SET-2
const BEFORE_SYNC: Folder[] = [
  { path: "/settings/goals", title: "Goals", holds: "Calorie target, fasting, keto carb limit" },
  { path: "/settings/coach", title: "Coach", holds: "What it's for, how it talks, check-ins, its model" },
  {
    path: "/settings/health",
    title: "Health data",
    holds: isAndroid ? "Health Connect and Garmin" : "Watch data arrives from the phone",
  },
  { path: "/settings/ai", title: "AI", holds: "OpenRouter key, photo model, product lookups, costs" },
];
const AFTER_SYNC: Folder[] = [{ path: "/settings/general", title: "General", holds: "Theme, export database, about" }];

function FolderRow({ f }: { f: Folder }) {
  return (
    <Link to={f.path} className="list-row" style={{ color: "inherit", textDecoration: "none", marginBottom: 12 }}>
      <div className="row-main">
        <div className="row-title">{f.title}</div>
        <div className="row-sub">{f.holds}</div>
      </div>
      <div className="row-end faint">›</div>
    </Link>
  );
}

// Spec: SET-1
// Spec: SET-2
/** Settings: the folders, each opening on its own page. */
export default function SettingsPage() {
  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title">Settings</h1>
      </header>
      {BEFORE_SYNC.map((f) => (
        <FolderRow key={f.path} f={f} />
      ))}
      <SyncLink />
      {AFTER_SYNC.map((f) => (
        <FolderRow key={f.path} f={f} />
      ))}
    </div>
  );
}
