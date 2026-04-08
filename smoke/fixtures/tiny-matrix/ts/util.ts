export interface Renderable {
  render(name: string): string;
}

export function formatLabel(name: string): string {
  return `TS:${name}`;
}
