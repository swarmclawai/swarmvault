declare module "node-mbox" {
  import type { Readable, Transform } from "node:stream";

  export class Mbox extends Transform {}
  export function MboxStream(stream: Readable, options?: { includeMboxHeader?: boolean }): Transform;
}
