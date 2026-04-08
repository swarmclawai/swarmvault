import { BaseWidget, formatLabel } from "./util.js";

export class Widget extends BaseWidget {
  render(name) {
    return formatLabel(name);
  }
}
