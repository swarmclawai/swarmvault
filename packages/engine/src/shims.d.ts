declare module "node-mbox" {
  import type { Readable, Transform } from "node:stream";

  export class Mbox extends Transform {}
  export function MboxStream(stream: Readable, options?: { includeMboxHeader?: boolean }): Transform;
}

// `istextorbinary` ships its types via conditional `exports.node.types`, which tsup's
// dts generator does not always pick up. Provide a minimal inline declaration so both
// tsc and the dts build resolve the module without installing the deprecated
// `@types/istextorbinary` stub.
declare module "istextorbinary" {
  export function isText(filename?: string | null, buffer?: Uint8Array | Buffer | null): boolean | null;
  export function isBinary(filename?: string | null, buffer?: Uint8Array | Buffer | null): boolean | null;
  export function getEncoding(
    buffer?: Uint8Array | Buffer | null,
    options?: { chunkLength?: number; chunkBegin?: number }
  ): "utf8" | "binary" | null;
}
