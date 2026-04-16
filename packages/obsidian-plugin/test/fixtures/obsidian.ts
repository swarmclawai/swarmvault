// Minimal mock of the `obsidian` module surface the plugin imports at test time.
// Only types/classes referenced from code-under-test need to exist here.

export class Plugin {
  app: App = new App();
  manifest: PluginManifest = { version: "0.0.0" };
  loadData = async (): Promise<unknown> => null;
  saveData = async (_data: unknown): Promise<void> => undefined;
  addStatusBarItem = (): HTMLElement => createMockEl();
  addSettingTab = (_tab: unknown): void => undefined;
  addCommand = (_def: unknown): void => undefined;
  registerView = (_type: string, _factory: (leaf: WorkspaceLeaf) => unknown): void => undefined;
}

export class PluginSettingTab {
  containerEl: HTMLElement = createMockEl();
  constructor(
    public app: App,
    public plugin: unknown
  ) {}
  display(): void {}
  hide(): void {}
}

export class Setting {
  constructor(public containerEl: HTMLElement) {}
  setName(_v: string): this {
    return this;
  }
  setDesc(_v: string): this {
    return this;
  }
  addText(_fn: (t: unknown) => void): this {
    return this;
  }
  addTextArea(_fn: (t: unknown) => void): this {
    return this;
  }
  addToggle(_fn: (t: unknown) => void): this {
    return this;
  }
  addDropdown(_fn: (d: unknown) => void): this {
    return this;
  }
  addButton(_fn: (b: unknown) => void): this {
    return this;
  }
}

export class Modal {
  app: App;
  contentEl: HTMLElement = createMockEl();
  constructor(app: App) {
    this.app = app;
  }
  open(): void {
    this.onOpen?.();
  }
  close(): void {
    this.onClose?.();
  }
  onOpen?(): void;
  onClose?(): void;
}

export class ItemView {
  contentEl: HTMLElement = createMockEl();
  constructor(public leaf: WorkspaceLeaf) {}
  getViewType(): string {
    return "mock";
  }
  getDisplayText(): string {
    return "mock";
  }
  getIcon(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class Notice {
  hide(): void {}
}

export class TFile {
  path = "";
  basename = "";
}

export class MarkdownView {
  editor = {
    getSelection: () => "",
    replaceSelection: (_v: string) => {},
    replaceRange: (_v: string, _p: unknown) => {},
    lineCount: () => 0,
    getLine: (_n: number) => ""
  };
}

export class FileSystemAdapter {
  getBasePath(): string {
    return "";
  }
}

export class App {
  workspace = {
    getActiveFile: () => null as TFile | null,
    getActiveViewOfType: (_ctor: unknown) => null,
    getLeavesOfType: (_type: string) => [] as WorkspaceLeaf[],
    getRightLeaf: (_split: boolean) => null as WorkspaceLeaf | null,
    getLeaf: (_split: boolean) => null as WorkspaceLeaf | null,
    revealLeaf: (_leaf: WorkspaceLeaf) => {}
  };
  vault = {
    adapter: new FileSystemAdapter(),
    getAbstractFileByPath: (_p: string) => null,
    create: async (_name: string, _content: string) => new TFile()
  };
}

export interface WorkspaceLeaf {
  view: unknown;
  setViewState: (state: unknown) => Promise<void>;
  openFile: (file: TFile) => Promise<void>;
}

export interface PluginManifest {
  version: string;
  swarmvaultCliMinVersion?: string;
}

function createMockEl(): HTMLElement {
  const el = {
    empty: () => {},
    addClass: (_c: string) => {},
    createSpan: (_opts?: unknown) => createMockEl(),
    createEl: (_tag: string, _attrs?: unknown) => createMockEl(),
    setText: (_v: string) => {},
    setAttr: (_k: string, _v: string) => {},
    onClickEvent: (_cb: () => void) => {},
    onclick: null as (() => void) | null,
    className: "",
    style: {} as Record<string, string>,
    inputEl: {} as unknown
  } as unknown as HTMLElement;
  return el;
}
