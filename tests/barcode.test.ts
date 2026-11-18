import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import "./testDb";
import { parseJson } from "../src/lib/schemas";

// The app loads the decoder's WebAssembly through Vite (`?url`); here it's
// handed the bytes from node_modules instead.
const wasm = readFileSync(new URL("../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", import.meta.url));
mock.module("../src/lib/barcodeWasm", () => ({
  zxingOverrides: async () => ({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) }),
}));

const { dataUrlBytes, gtinProblem, isValidGtin, readProductBarcodes } = await import("../src/lib/barcode");
const { executeFoodFactsSearch } = await import("../src/lib/openFoodFacts");

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, import.meta.url)));

describe("check digits", () => {
  test("hold for real codes of every length", () => {
    expect(isValidGtin("4056489328025")).toBe(true); // EAN-13, the quark bar below
    expect(isValidGtin("96385074")).toBe(true); // EAN-8
    expect(isValidGtin("036000291452")).toBe(true); // UPC-A
    expect(isValidGtin("10614141000415")).toBe(true); // GTIN-14
  });

  test("break on one misread digit or two swapped neighbours", () => {
    expect(isValidGtin("4056489328026")).toBe(false);
    expect(isValidGtin("4056489828025")).toBe(false);
    expect(isValidGtin("4056498328025")).toBe(false);
    expect(isValidGtin("405648932802")).toBe(false); // a digit short
    expect(isValidGtin("40564893280a5")).toBe(false);
  });

  test("a misread code is turned back with a reason, before any lookup", async () => {
    expect(gtinProblem("4056489328025")).toBeNull();
    expect(gtinProblem("Coca-Cola Zero")).toBeNull(); // a name search, not a barcode
    expect(gtinProblem("4056489328026")).toContain("fails its check digit");
    expect(gtinProblem("40564893")).toContain("fails its check digit");
    expect(gtinProblem("4056489")).toContain("8, 12, 13 or 14 digits");
    // No network in tests: an answer at all means it never got that far.
    const answer = parseJson(await executeFoodFactsSearch({ query: "4056489328026" }));
    expect(answer).toEqual({ products: [], error: expect.stringContaining("fails its check digit") });
  });
});

describe("reading barcodes off a photo", () => {
  test("a crumpled wrapper, photographed at an angle", async () => {
    expect(await readProductBarcodes(fixture("./fixtures/barcode-quark-bar.jpg"))).toEqual(["4056489328025"]);
  });

  test("nothing from a picture without one", async () => {
    expect(await readProductBarcodes(fixture("../app-icon.png"))).toEqual([]);
  });

  test("photos arrive as data URLs", () => {
    expect(dataUrlBytes("data:image/jpeg;base64,/9j/4A==")).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
    expect(dataUrlBytes("not a data url")).toBeNull();
  });
});
