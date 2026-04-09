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

// `rtf-parser` has no published type definitions. Provide a minimal inline
// declaration for the callback-based string parsing API used by extractRtfText.
declare module "rtf-parser" {
  export interface RtfSpan {
    value?: string;
    style?: Record<string, unknown>;
  }
  export interface RtfParagraph {
    content?: RtfSpan[];
    style?: Record<string, unknown>;
  }
  export interface RtfDocument {
    content?: Array<RtfParagraph | RtfSpan>;
    style?: Record<string, unknown>;
    charset?: string;
  }
  function parse(cb: (err: Error | null, doc: RtfDocument) => void): NodeJS.WritableStream;
  namespace parse {
    function string(input: string, cb: (err: Error | null, doc: RtfDocument) => void): void;
    function stream(stream: NodeJS.ReadableStream, cb: (err: Error | null, doc: RtfDocument) => void): void;
  }
  export default parse;
  export { parse };
}
