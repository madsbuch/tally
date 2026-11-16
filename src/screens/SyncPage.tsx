import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { useUp } from "../lib/navigation";
import {
  ago,
  backupLine,
  backupState,
  cancelPairing,
  createPairingCode,
  getSyncStatus,
  isAndroid,
  joinVault,
  onSyncStatus,
  removeDevice,
  setDeviceName,
  syncNow,
} from "../lib/sync";
import type { SyncDevice, SyncStatus } from "../lib/sync";
import InfoButton from "../components/InfoButton";

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

function DeviceRow({ d, onRemove }: { d: SyncDevice; onRemove: (d: SyncDevice) => void }) {
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
      </div>
      <button className="btn btn-ghost btn-sm" onClick={() => onRemove(d)}>
        Remove
      </button>
    </div>
  );
}

export default function SyncPage() {
  const up = useUp();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [joining, setJoining] = useState<"idle" | "scanning" | "working">("idle");
  const [pasted, setPasted] = useState("");
  const [joined, setJoined] = useState<string | null>(null);

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
        const outcome = await joinVault(c);
        setJoined(
          outcome.complete
            ? `Joined ${outcome.peer_name}'s vault: everything is here.`
            : `Joined ${outcome.peer_name}'s vault; the rest follows on the next sync.`,
        );
        void refresh();
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setJoining("idle");
      }
    },
    [refresh],
  );

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
    if (!window.confirm(`Remove ${d.name} from the vault? It stops syncing; what it already has stays on it.`)) return;
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
          ‹ Settings
        </button>
      </header>

      {error && (
        <div className="card" style={{ borderColor: "var(--bad, #c44)" }}>
          <p className="small" style={{ margin: 0 }}>
            {error}
          </p>
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
                  <DeviceRow key={d.id} d={d} onRemove={(x) => void remove(x)} />
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
            ) : !status.canJoin ? (
              <p className="muted small" style={{ margin: 0 }}>
                This device already holds a diary, so it can't join another
                one: joining only ever fills an empty device. Show the pairing
                code here, and scan it from the new device instead.
              </p>
            ) : joining === "working" ? (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div className="spinner" />
                <span className="small muted">Copying everything over…</span>
              </div>
            ) : (
              <>
                <p className="muted small" style={{ margin: "0 0 10px" }}>
                  Scan the code the other device shows, on the same network.
                  This device is empty, so it simply becomes a copy of it.
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
