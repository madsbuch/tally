/**
 * Where the barcode decoder's WebAssembly comes from: the copy Vite bundles
 * with the app — by default zxing-wasm would fetch it from a CDN, which
 * neither works offline nor passes the app's CSP. Its own module so tests
 * (which have no Vite to resolve `?url`) can hand over the bytes instead.
 */
import type { ZXingModuleOverrides } from "zxing-wasm/reader";

export async function zxingOverrides(): Promise<ZXingModuleOverrides> {
  const { default: wasmUrl } = await import("zxing-wasm/reader/zxing_reader.wasm?url");
  return {
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  };
}
