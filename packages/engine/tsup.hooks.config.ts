import { defineConfig } from "tsup";

// Bundle the hook scripts as standalone ESM files installed into user
// projects. Each hook must be fully self-contained so the installer can
// copy a single file into a user's .claude/.gemini/.github/.opencode
// directory without extra chunk files. `splitting: false` keeps the
// marker-state helpers inlined into every hook build.
const commonOptions = {
  format: ["esm"] as const,
  outDir: "dist/hooks",
  dts: false,
  sourcemap: false,
  clean: false,
  splitting: false,
  bundle: true
};

export default defineConfig([
  {
    ...commonOptions,
    entry: { claude: "src/hooks/claude.ts" },
    banner: { js: "#!/usr/bin/env node" }
  },
  {
    ...commonOptions,
    entry: { gemini: "src/hooks/gemini.ts" },
    banner: { js: "#!/usr/bin/env node" }
  },
  {
    ...commonOptions,
    entry: { copilot: "src/hooks/copilot.ts" },
    banner: { js: "#!/usr/bin/env node" }
  },
  {
    ...commonOptions,
    entry: { opencode: "src/hooks/opencode.ts" }
  }
]);
