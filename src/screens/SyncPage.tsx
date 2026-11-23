import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { useUp, useUpLabel } from "../lib/navigation";
import {
  ago,
  backupLine,
  backupState,
  cancelPairing,
  checkConnection,
  createPairingCode,
  getSyncStatus,
  isAndroid,
  joinVault,
  onSyncStatus,
  openNetworkSettings,
  describeHeld,
  removeDevice,
  setDeviceName,
  syncNow,
} from "../lib/sync";
import type { ConnectionCheck, SyncDevice, SyncProblem, SyncStatus } from "../lib/sync";
import InfoButton from "../components/InfoButton";
import { confirmAction } from "../lib/confirm";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Scans a QR code: the phone's camera through the barcode plugin. */
async function scanWithPhone(): Promise<string | null> {
  const { scan, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
  let perm = await checkPermissions();
  if (perm !== "granted") perm = await requestPermissions();
  if (perm !== "granted") throw new Error("Tally needs the camera to scan the code.");
  const r = await scan({ formats: [Format.QRCode], windowed: false });
  return r.content || null;
}

// Spec: tandem.SYN-21
/** The computer's webcam, read frame by frame until a QR code shows up. */
function WebcamScanner({ onCode, onError }: { onCode: (c: string) => void; onError: (e: string) => void }) {
  const video = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (done) return;
      const v = video.current;
      if (v && ctx && v.readyState >= 2 && v.videoWidth > 0) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const hit = jsQR(img.data, img.width, img.height);
        if (hit?.data.startsWith("tally-pair:")) {
          done = true;
          onCode(hit.data);
          return;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "environment" } })
      .then((s) => {
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
        }
        frame = requestAnimationFrame(tick);
      })
      .catch((e) => onError(`The camera isn't available (${errMsg(e)}). Paste the code instead.`));
    if (!navigator.mediaDevices) onError("No camera here. Paste the code instead.");
    return () => {
      done = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onCode, onError]);
  return (
    <video
      ref={video}
      muted
      playsInline
      style={{ width: "100%", borderRadius: 12, background: "#000", aspectRatio: "4 / 3", objectFit: "cover" }}
    />
  );
}

// Spec: tandem.SYN-24
/** A reason in plain words, with the button to the setting that fixes it. */
function ProblemLine({ p }: { p: SyncProblem }) {
  return (
    <p className="small" style={{ margin: "4px 0 0" }}>
      {p.message}
      {p.hasSetting && (
        <>
          {" "}
          <button className="btn btn-ghost btn-sm" onClick={() => void openNetworkSettings().catch(() => {})}>
            Open Local Network settings
          </button>
        </>
      )}
    </p>
  );
}

function DeviceRow({ d, problem, onRemove }: { d: SyncDevice; problem: SyncProblem | undefined; onRemove: (d: SyncDevice) => void }) {
  return (
    <div className="list-row" style={{ marginBottom: 0 }}>
      <div className="row-main">
        <div className="row-title">
          {d.name} <span className="faint small">· {d.platform === "android" ? "phone" : "computer"}</span>
        </div>
        <div className="row-sub">
          {d.lastSyncAt
            ? `Synced ${ago(d.lastSyncAt)}${d.complete ? " · identical" : " · not identical yet"}`
            : "Not synced yet"}
        </div>
        {problem && <ProblemLine p={problem} />}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => onRemove(d)}>
        Remove
      </button>
    </div>
  );
}

// Spec: tandem.SYN-23
/** Settings → Sync's connection check: what it found, and what's in the way. */
function CheckReport({ c }: { c: ConnectionCheck }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div>
        <div className="row-title">This device</div>
        <p className="small muted" style={{ margin: "2px 0 0" }}>
          {c.addresses.length > 0 ? `On the network at ${c.addresses.join(", ")}.` : "Not on a local network."}{" "}
          {c.listening ? `Sync listens on port ${c.port}.` : "Sync isn't listening."}
        </p>
      </div>
      {c.inVault && (
        <div>
          <div className="row-title">Answered the search</div>
          <p className="small muted" style={{ margin: "2px 0 0" }}>
            {c.answered.length > 0
              ? c.answered.map((a) => `${a.name} (${a.via.join(", ")})`).join(", ")
              : "None of the vault's devices answered."}
          </p>
        </div>
      )}
      {c.devices.map((d) => (
        <div key={`${d.deviceId ?? "code"}-${d.name}`}>
          <div className="row-title">
            {d.name}
            {d.joinedCode && <span className="faint small"> · the code last joined</span>}
          </div>
          {d.reachedAt ? (
            <p className="small muted" style={{ margin: "2px 0 0" }}>
              Reached at {d.reachedAt}.
            </p>
          ) : (
            d.problem && <ProblemLine p={d.problem} />
          )}
        </div>
      ))}
      <div>
        <div className="row-title">What's in the way</div>
        {c.problems.length > 0 ? (
          c.problems.map((p) => <ProblemLine key={p.message} p={p} />)
        ) : (
          <p className="small muted" style={{ margin: "2px 0 0" }}>
            {c.devices.length > 0 ? "Nothing: every device can be reached." : "Nothing on this device. Pair another to sync with."}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SyncPage() {
  const up = useUp();
  const upLabel = useUpLabel("Settings");
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [joining, setJoining] = useState<"idle" | "scanning" | "working">("idle");
  const [pasted, setPasted] = useState("");
  const [joined, setJoined] = useState<string | null>(null);
  /** The person agreed to replace what this device holds (a copy is saved first). */
  const [replace, setReplace] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | "checking" | null>(null);

  async function runCheck() {
    setCheck("checking");
    try {
      setCheck(await checkConnection());
    } catch (e) {
      setCheck(null);
      setError(errMsg(e));
    }
  }

  const refresh = useCallback(async () => {
    try {
      const s = await getSyncStatus();
      setStatus(s);
      setName((n) => n || s.name);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const off = onSyncStatus(() => void refresh());
    // Device lists and "synced N min ago" move on their own.
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [refresh]);

  // Leaving the page takes the code down.
  useEffect(() => () => void cancelPairing().catch(() => {}), []);

  async function showCode() {
    setError(null);
    try {
      const c = await createPairingCode();
      setCode(c);
      setQr(await QRCode.toDataURL(c, { margin: 1, width: 320, errorCorrectionLevel: "M" }));
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function hideCode() {
    await cancelPairing().catch(() => {});
    setCode(null);
    setQr(null);
  }

  const join = useCallback(
    async (c: string) => {
      setJoining("working");
      setError(null);
      try {
        const { outcome, backup } = await joinVault(c, replace);
        setJoined(
          (outcome.complete
            ? `Joined ${outcome.peer_name}'s vault: everything is here.`
            : `Joined ${outcome.peer_name}'s vault; the rest follows on the next sync.`) +
            (backup ? ` What this device held before is saved at ${backup}.` : ""),
        );
        setReplace(false);
        void refresh();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setJoining("idle");
      }
    },
    [refresh, replace],
  );

  // Spec: tandem.SYN-22
  async function askToReplace() {
    if (!status) return;
    const what = describeHeld(status.held);
    if (
      !(await confirmAction(
        `This device holds ${what}. Joining replaces all of it with the vault's data.\n\n` +
          "A complete copy of this device's database is saved first, in Tally's backups folder, so nothing is lost.",
        { confirmLabel: "Replace and join", danger: true },
      ))
    ) {
      return;
    }
    setReplace(true);
  }

  async function scan() {
    setError(null);
    if (isAndroid()) {
      try {
        const c = await scanWithPhone();
        if (c) await join(c);
      } catch (e) {
        setError(errMsg(e));
      }
    } else {
      setJoining("scanning");
    }
  }

  async function saveName() {
    const n = name.trim();
    if (!n || n === status?.name) return;
    try {
      await setDeviceName(n);
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function remove(d: SyncDevice) {
    if (!(await confirmAction(`Remove ${d.name} from the vault? It stops syncing; what it already has stays on it.`, { confirmLabel: "Remove", danger: true }))) return;
    try {
      await removeDevice(d.id);
      void refresh();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const others = status?.devices.filter((d) => !d.isSelf) ?? [];
  const state = status ? backupState(status) : null;
  // A new device appeared while the code was up: it worked.
  const paired = code !== null && others.some((d) => d.lastCompleteAt && Date.now() - Date.parse(d.lastCompleteAt) < 60_000);

  return (
    <div className="page">
      <header className="page-header">
        <h1 className="page-title" style={{ display: "flex", alignItems: "center", gap: 2 }}>
          Sync & backup
          <InfoButton title="Sync & backup">
            <p>
              Your devices keep one shared copy of everything (diary, chats,
              photos, documents and settings), synced directly over your home
              network whenever they can see each other. Nothing goes through a
              server.
            </p>
            <p>
              That makes the computer a backup of the phone: if the phone is
              lost, a new one joins with an empty Tally and gets everything
              back. The computer also keeps a copy of the whole database every
              day for two weeks, then one a week for about three months.
            </p>
            <p>
              A device can only join while it holds no data of its own, so
              joining never mixes two diaries or overwrites anything.
            </p>
          </InfoButton>
        </h1>
        <button className="btn btn-ghost btn-sm" onClick={up}>
          ‹ {upLabel}
        </button>
      </header>

      {error && (
        <div className="card" style={{ borderColor: "var(--bad, #c44)" }}>
          <p className="small" style={{ margin: 0 }}>
            {error}
          </p>
          {status?.joinProblem?.hasSetting && <ProblemLine p={status.joinProblem} />}
        </div>
      )}

      {status === null ? (
        <div className="spinner" />
      ) : (
        <>
          {state && state.kind !== "none" && (
            <div className="card">
              <h2 className="card-title">Backup</h2>
              <p className="small" style={{ margin: "0 0 10px" }}>
                {backupLine(state)}
              </p>
              {status.lastError && (
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  Last problem: {status.lastError}
                </p>
              )}
              <button className="btn btn-sm" onClick={() => void syncNow()} disabled={status.syncing}>
                {status.syncing ? "Syncing…" : "Sync now"}
              </button>
            </div>
          )}

          <div className="card">
            <h2 className="card-title">This device</h2>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="input"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                onBlur={() => void saveName()}
                aria-label="This device's name"
              />
            </div>
            <p className="faint small" style={{ margin: "6px 0 0" }}>
              What the other devices call it.
            </p>
          </div>

          {others.length > 0 && (
            <>
              <div className="section-title">Devices in the vault</div>
              <div className="card" style={{ display: "grid", gap: 8 }}>
                {others.map((d) => (
                  <DeviceRow
                    key={d.id}
                    d={d}
                    problem={status.unreached.find((u) => u.deviceId === d.id)?.problem}
                    onRemove={(x) => void remove(x)}
                  />
                ))}
              </div>
            </>
          )}

          <div className="section-title">Add a device</div>
          <div className="card">
            {code && qr ? (
              <>
                {paired ? (
                  <p className="small" style={{ margin: "0 0 10px" }}>
                    Paired. The new device has a full copy.
                  </p>
                ) : (
                  <p className="muted small" style={{ margin: "0 0 10px" }}>
                    On the other device, open Settings → Sync & backup → Join,
                    and scan this. It works once, for ten minutes, on this
                    network.
                  </p>
                )}
                <img src={qr} alt="Pairing code" style={{ width: "100%", maxWidth: 320, display: "block", margin: "0 auto 10px", borderRadius: 8, background: "#fff" }} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(code)}>
                    Copy code
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void hideCode()}>
                    Done
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  Shows a code the other device scans. That device must have
                  an empty Tally; it gets a full copy of this one.
                </p>
                <button className="btn btn-primary btn-sm" onClick={() => void showCode()}>
                  Show pairing code
                </button>
              </>
            )}
          </div>

          <div className="section-title">Join a vault</div>
          <div className="card">
            {joined ? (
              <p className="small" style={{ margin: 0 }}>
                {joined}
              </p>
            ) : !status.canJoin && !replace ? (
              <>
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  This device holds {describeHeld(status.held)}, so joining
                  would replace it. If this is the device with your diary, show
                  the pairing code here and scan it from the other device
                  instead. If what's here doesn't matter — left over from an
                  earlier install, say — replace it: a copy is saved first.
                </p>
                <button className="btn btn-sm" onClick={askToReplace}>
                  Replace this device's data and join…
                </button>
              </>
            ) : joining === "working" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="spinner" />
                <span className="small muted">Copying everything over…</span>
              </div>
            ) : (
              <>
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  {replace
                    ? "Scan the code the other device shows, on the same network. What's here is saved to a backup, then replaced by the vault's data."
                    : "Scan the code the other device shows, on the same network. This device is empty, so it simply becomes a copy of it."}
                </p>
                {joining === "scanning" && (
                  <div style={{ marginBottom: 10 }}>
                    <WebcamScanner
                      onCode={(c) => void join(c)}
                      onError={(e) => {
                        setError(e);
                        setJoining("idle");
                      }}
                    />
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => void scan()} disabled={joining === "scanning"}>
                    {joining === "scanning" ? "Looking for the code…" : "Scan code"}
                  </button>
                  {joining === "scanning" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setJoining("idle")}>
                      Cancel
                    </button>
                  )}
                  {replace && joining !== "scanning" && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setReplace(false)}>
                      Keep what's here
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    className="input"
                    placeholder="…or paste the code"
                    value={pasted}
                    onChange={(e) => setPasted(e.target.value)}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={!pasted.trim().startsWith("tally-pair:")}
                    onClick={() => void join(pasted.trim())}
                  >
                    Join
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="section-title">Connection</div>
          <div className="card">
            {check === null ? (
              <>
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  When devices don't sync, this finds out why: whether this
                  device is on the network, which devices answer, and what's
                  in the way.
                </p>
                <button className="btn btn-sm" onClick={() => void runCheck()}>
                  Check the connection
                </button>
              </>
            ) : check === "checking" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="spinner" />
                <span className="small muted">Checking…</span>
              </div>
            ) : (
              <>
                <CheckReport c={check} />
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 10 }} onClick={() => void runCheck()}>
                  Check again
                </button>
              </>
            )}
          </div>

          {status.lastRoundAt && (
            <p className="faint small" style={{ textAlign: "center" }}>
              Last looked for devices {ago(status.lastRoundAt)}
            </p>
          )}
        </>
      )}
    </div>
  );
}
