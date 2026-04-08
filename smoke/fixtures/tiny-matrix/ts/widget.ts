import { formatLabel, type Renderable } from "./util";

export class Widget implements Renderable {
  render(name: string): string {
    return formatLabel(name);
  }
}
