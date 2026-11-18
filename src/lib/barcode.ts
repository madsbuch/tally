/**
 * Barcodes read off a photo by the app itself, before the model sees it.
 *
 * A model reading the digits printed under the bars is guessing: one misread
 * digit is no match, or a different product. Decoding the bars is exact, and
 * the check digit (`isValidGtin`) catches what's left. It runs on the device
 * (zxing-cpp compiled to WebAssembly, bundled with the app, nothing fetched),
 * in well under a second, and when it finds nothing — glare, a crumpled
 * wrapper, no barcode at all — the capture goes on as it always did.
 */
import type { ReaderOptions } from "zxing-wasm/reader";
import { zxingOverrides } from "./barcodeWasm";

/** The retail codes Open Food Facts files products under. */
const READER_OPTIONS: ReaderOptions = {
  formats: ["EAN-13", "EAN-8", "UPC-A"],
  tryHarder: true,
  // A photo of a meal can hold a few packages; more than this is noise.
  maxNumberOfSymbols: 4,
};

/**
 * Whether `code` is a well-formed GTIN (EAN-8, UPC-A, EAN-13, GTIN-14): digits
 * only, and its last digit the check digit of the rest — which a single
 * misread digit, or two swapped neighbours, almost always breaks.
 */
export function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12,14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  // Weights run 3, 1, 3, … from the digit next to the check digit.
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return check === (10 - (sum % 10)) % 10;
}

/** Why a barcode won't do, worded for the model; null when it will. */
export function gtinProblem(code: string): string | null {
  if (!/^\d+$/.test(code)) return null;
  if (!/^(\d{8}|\d{12,14})$/.test(code)) {
    return `${code} isn't a product barcode: those have 8, 12, 13 or 14 digits. Read it again, or search by the product's name.`;
  }
  if (!isValidGtin(code)) {
    return `${code} fails its check digit, so a digit is misread. Read it again, or search by the product's name.`;
  }
  return null;
}

let reader: Promise<typeof import("zxing-wasm/reader")> | null = null;

/** The decoder, loaded on first use from the copy bundled with the app. */
function zxing(): Promise<typeof import("zxing-wasm/reader")> {
  reader ??= (async () => {
    const mod = await import("zxing-wasm/reader");
    mod.prepareZXingModule({ overrides: await zxingOverrides(), fireImmediately: true });
    return mod;
  })();
  return reader;
}

/** The distinct valid product barcodes in an image file (JPEG, PNG, …), in reading order. */
export async function readProductBarcodes(image: Uint8Array): Promise<string[]> {
  const { readBarcodes } = await zxing();
  const found = await readBarcodes(image, READER_OPTIONS);
  const codes: string[] = [];
  for (const r of found) {
    if (r.isValid && isValidGtin(r.text) && !codes.includes(r.text)) codes.push(r.text);
  }
  return codes;
}

/** The bytes of a `data:` URL, as `readPhotoDataUrl` hands photos back. */
export function dataUrlBytes(dataUrl: string): Uint8Array | null {
  const m = /^data:[^,]*;base64,(.*)$/s.exec(dataUrl);
  if (!m?.[1]) return null;
  const bin = atob(m[1]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
