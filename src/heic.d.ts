// heic-decode's decoder over a libheif of our choosing (see heicDecoder in
// lib/photos.ts); the package ships no types for this entry point.
declare module "heic-decode/lib.js" {
  type Decoded = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };
  /** `one` decodes a file's primary image; `all` (unused here) every image in it. */
  const decoderFor: (libheif: unknown) => { one: (opts: { buffer: Uint8Array }) => Promise<Decoded> };
  export default decoderFor;
}
