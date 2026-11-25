import { useEffect, useMemo, useRef, useState } from "react";
import { deleteSetting, getSetting, setSetting } from "../lib/db";
import { chat, fetchModels, isVisionModel, supportsTools } from "../lib/openrouter";
import { DEFAULT_VISION_MODEL, SETTING_KEYS } from "../lib/types";
import type { ORModel } from "../lib/types";
import { parseJson, parseModelList } from "../lib/schemas";
import CostCenterLink from "../components/CostCenterLink";
import ModelRow, { modelSub } from "../components/ModelRow";
import FoodCountrySetting from "../components/FoodCountrySetting";
import { confirmAction } from "../lib/confirm";
import SettingsFolder from "../components/SettingsFolder";

const MAX_LIST_ROWS = 40;

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok" }
  | { status: "error"; message: string };

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "sk-or-…1234" style mask: recognizable head, last 4 chars. */
function maskKey(key: string): string {
  // Short keys would be fully revealed by head+tail — mask entirely.
  if (key.length <= 8) return "••••";
  const tail = key.slice(-4);
  const head = key.startsWith("sk-or-") ? "sk-or-" : key.slice(0, 4);
  return `${head}…${tail}`;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

// Spec: SET-1
/** Settings → AI: the OpenRouter key, the model that reads photos, product lookups and the cost center. */
export default function SettingsAiPage() {
  const [loading, setLoading] = useState(true);

  // OpenRouter API key
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });

  // Vision model
  const [models, setModels] = useState<ORModel[]>([]);
  const [cacheAt, setCacheAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_VISION_MODEL);
  // The model list is long — keep it tucked away until explicitly opened.
  const [showModelPicker, setShowModelPicker] = useState(false);

  const bootedRef = useRef(false);

  async function refreshModels(silent: boolean) {
    setRefreshing(true);
    if (!silent) setRefreshError(null);
    try {
      const list = await fetchModels();
      const at = new Date().toISOString();
      setModels(list);
      setCacheAt(at);
      setRefreshError(null);
      await setSetting(SETTING_KEYS.modelsCache, JSON.stringify(list));
      await setSetting(SETTING_KEYS.modelsCacheAt, at);
    } catch (e) {
      // Offline is fine on the silent boot refresh.
      if (!silent) setRefreshError(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    (async () => {
      try {
        const [key, model, cache, at] = await Promise.all([
          getSetting(SETTING_KEYS.openrouterApiKey),
          getSetting(SETTING_KEYS.visionModel),
          getSetting(SETTING_KEYS.modelsCache),
          getSetting(SETTING_KEYS.modelsCacheAt),
        ]);
        setSavedKey(key);
        if (model) setSelectedModel(model);
        let cached: ORModel[] | null = null;
        if (cache) {
          try {
            cached = parseModelList(parseJson(cache));
          } catch {
            cached = null;
          }
        }
        if (cached && cached.length > 0) {
          setModels(cached);
          setCacheAt(at);
        } else {
          void refreshModels(true);
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavedKey(key);
    setKeyInput("");
    setShowKey(false);
    setTest({ status: "idle" });
    await setSetting(SETTING_KEYS.openrouterApiKey, key);
  }

  async function removeKey() {
    if (!(await confirmAction("Remove the OpenRouter API key from this device?", { confirmLabel: "Remove", danger: true }))) return;
    setSavedKey(null);
    setTest({ status: "idle" });
    await deleteSetting(SETTING_KEYS.openrouterApiKey);
  }

  async function testConnection() {
    if (!savedKey) return;
    setTest({ status: "testing" });
    try {
      await chat(savedKey, selectedModel, [
        { role: "user", content: "Reply with exactly: OK" },
      ], "test");
      setTest({ status: "ok" });
    } catch (e) {
      setTest({ status: "error", message: errorMessage(e) });
    }
  }

  async function selectModel(id: string) {
    setSelectedModel(id);
    setTest({ status: "idle" });
    setShowModelPicker(false);
    await setSetting(SETTING_KEYS.visionModel, id);
  }

  const visionModels = useMemo(() => {
    const list = models.filter((m) => isVisionModel(m) && supportsTools(m));
    list.sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    return list;
  }, [models]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q) {
      return visionModels.filter(
        (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
      );
    }
    // No search: pin the selected model at the top.
    const sel = visionModels.find((m) => m.id === selectedModel);
    return sel
      ? [sel, ...visionModels.filter((m) => m.id !== selectedModel)]
      : visionModels;
  }, [visionModels, search, selectedModel]);

  const shown = filtered.slice(0, MAX_LIST_ROWS);
  const hiddenCount = filtered.length - shown.length;
  const selectedInfo = models.find((m) => m.id === selectedModel) ?? null;

  if (loading) {
    return (
      <SettingsFolder title="AI">
        <div className="empty">
          <div className="spinner" style={{ margin: "0 auto" }} />
        </div>
      </SettingsFolder>
    );
  }

  return (
    <SettingsFolder title="AI">
      <CostCenterLink />
      <div className="card">
        <h2 className="card-title">OpenRouter API key</h2>
        <p className="muted small" style={{ margin: "0 0 10px" }}>
          Powers the photo diary: captures are sent to an AI model of your
          choice for analysis. Create a key at openrouter.ai/keys.
        </p>
        <div className="field">
          <label className="label" htmlFor="or-key">
            API key
          </label>
          <div className="input-row">
            <input
              id="or-key"
              className="input"
              type={showKey ? "text" : "password"}
              placeholder="sk-or-…"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <button
              className="btn btn-ghost"
              style={{ flex: "0 0 auto" }}
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? "Hide" : "Show"}
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: "0 0 auto" }}
              onClick={() => void saveKey()}
              disabled={!keyInput.trim()}
            >
              Save
            </button>
          </div>
        </div>
        {savedKey ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="chip chip-accent">Key saved · {maskKey(savedKey)}</span>
            <button className="btn btn-ghost btn-sm" onClick={() => void removeKey()}>
              Remove
            </button>
          </div>
        ) : (
          <div className="muted small">No API key saved yet.</div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
          <button
            className="btn btn-sm"
            onClick={() => void testConnection()}
            disabled={!savedKey || test.status === "testing"}
          >
            Test connection
          </button>
          {test.status === "testing" && <div className="spinner" />}
          {test.status === "ok" && <span className="chip chip-accent">✓ Working</span>}
        </div>
        {test.status === "error" && (
          <div className="error-text" style={{ marginTop: 8 }}>
            {test.message}
          </div>
        )}
        <p className="muted small" style={{ margin: "12px 0 0" }}>
          Stored only on this device.
        </p>
      </div>

      {/* Vision model ------------------------------------------------------ */}
      <div className="card">
        <h2 className="card-title">Vision model</h2>
        <div
          className="list-row"
          style={{ background: "var(--bg-elev)", marginBottom: 10 }}
        >
          <div className="row-main">
            <div className="row-title">{selectedInfo?.name ?? selectedModel}</div>
            <div className="row-sub">
              {selectedInfo ? modelSub(selectedInfo) : "Not in cached list"}
            </div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            style={{ flex: "0 0 auto" }}
            onClick={() => setShowModelPicker((v) => !v)}
          >
            {showModelPicker ? "Done" : "Change"}
          </button>
        </div>
        {!showModelPicker ? (
          <p className="muted small" style={{ margin: 0 }}>
            The model that analyzes your captures. Only vision models with tool
            calling are listed: the diary agent needs both.
          </p>
        ) : (
          <>
            <div
              style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}
            >
              <button
                className="btn btn-sm"
                onClick={() => void refreshModels(false)}
                disabled={refreshing}
              >
                Refresh models
              </button>
              {refreshing ? (
                <div className="spinner" />
              ) : (
                models.length > 0 &&
                cacheAt && (
                  <span className="faint small">
                    {models.length} models · refreshed {relativeTime(cacheAt)}
                  </span>
                )
              )}
            </div>
            {refreshError && (
              <div className="error-text" style={{ marginBottom: 8 }}>
                {refreshError}
              </div>
            )}
            <div className="field" style={{ marginBottom: 8 }}>
              <input
                className="input"
                placeholder="Search vision models…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            {visionModels.length === 0 ? (
              refreshing ? (
                <div className="empty">
                  <div className="spinner" style={{ margin: "0 auto" }} />
                </div>
              ) : (
                <div className="empty">
                  <div className="empty-icon">📡</div>
                  No models cached yet. Tap “Refresh models”.
                </div>
              )
            ) : shown.length === 0 ? (
              <div className="empty">No vision models match “{search.trim()}”.</div>
            ) : (
              <div className="list">
                {shown.map((m) => (
                  <ModelRow
                    key={m.id}
                    model={m}
                    selected={m.id === selectedModel}
                    onSelect={(id) => void selectModel(id)}
                  />
                ))}
                {hiddenCount > 0 && (
                  <div
                    className="faint small"
                    style={{ textAlign: "center", padding: "6px 0" }}
                  >
                    …and {hiddenCount} more. Refine your search
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <FoodCountrySetting />
    </SettingsFolder>
  );
}
