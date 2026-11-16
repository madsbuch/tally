// ---------------------------------------------------------------------------
// "Are you sure?" — asked in the app, not by the browser.
//
// `window.confirm` shows nothing in the desktop app's WebView and answers
// "no": every delete that asked first silently did nothing on the computer.
// So questions go through here instead, and <ConfirmHost/> (mounted once in
// _app) shows them as a sheet — a centred dialog on a wide window. ESLint
// keeps window.confirm/alert/prompt out of the code.
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  /** The button that says yes; "OK" if not given. */
  confirmLabel?: string;
  /** The button that says no; "Cancel" if not given. */
  cancelLabel?: string;
  /** A deletion or something else that can't be taken back: a red button. */
  danger?: boolean;
}

export interface ConfirmRequest extends ConfirmOptions {
  message: string;
  resolve: (yes: boolean) => void;
}

let current: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Asks `message`; resolves true for yes. One question at a time — a second
 *  one while the first is up answers the first "no". */
export function confirmAction(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    current?.resolve(false);
    current = { ...options, message, resolve };
    emit();
  });
}

/** Answers the question showing, and takes it down. */
export function answerConfirm(yes: boolean): void {
  const req = current;
  current = null;
  emit();
  req?.resolve(yes);
}

export function subscribeConfirm(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function currentConfirm(): ConfirmRequest | null {
  return current;
}
