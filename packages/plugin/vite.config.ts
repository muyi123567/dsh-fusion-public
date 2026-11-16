import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const entry = process.env.DSH_FUSION_CLIENT_ENTRY ?? "launcher";
if (!["launcher", "workspace", "terminal"].includes(entry)) throw new Error("DSH_FUSION_CLIENT_ENTRY_INVALID");
const fileName = entry === "launcher" ? "client.js" : `client.${entry}.js`;

function nativeTerminalImport(): Plugin {
  return {
    name: "dsh-fusion-native-terminal-import",
    enforce: "pre",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/features/terminal/TerminalTabs.tsx")) {
        const target = 'import("./TerminalWindow.js")';
        if (!code.includes(target)) throw new Error("DSH_FUSION_TERMINAL_IMPORT_CHANGED");
        return code.replace(target, 'require.async("./client.terminal.js")');
      }
    },
  };
}

function inlineWorkspaceStyles(): Plugin {
  return {
    name: "dsh-fusion-workspace-styles",
    enforce: "post",
    generateBundle: { order: "post", handler(_options, bundle) {
      const css = Object.values(bundle).filter((output) => output.type === "asset" && output.fileName.endsWith(".css"));
      for (const output of Object.values(bundle)) {
        if (output.type === "chunk") output.code = output.code.replaceAll("__DSH_FUSION_WORKSPACE_CSS__", JSON.stringify(css.map((asset) => String(asset.source)).join("\n")));
      }
      for (const asset of css) delete bundle[asset.fileName];
    } },
  };
}

function collectNoticeInputs(): Plugin {
  return {
    name: "dsh-fusion-third-party-notice-inputs",
    generateBundle: { order: "post", handler(_options, bundle) {
      const directory = process.env.DSH_FUSION_NOTICE_INPUTS;
      if (directory === undefined) return;
      const inputs = new Set<string>();
      const externals = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) {
          if (!id.startsWith(String.fromCharCode(0))) inputs.add(id);
        }
        for (const id of output.imports) externals.add(id);
      }
      // Each entry owns a separate manifest; all three are merged by build.mjs.
      writeFileSync(resolve(directory, entry + ".json"), JSON.stringify({
        inputs: [...inputs].sort(), externals: [...externals].sort(),
      }));
    } },
  };
}

export default defineConfig({
  plugins: [nativeTerminalImport(), react(), inlineWorkspaceStyles(), collectNoticeInputs()],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: { entry: entry === "launcher" ? "src/client.tsx" : `src/client.${entry}.tsx`, formats: ["cjs"], fileName: () => fileName },
    rollupOptions: {
      external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
      output: {
        // DSH's synchronous require cannot resolve relative Rollup shared chunks.
        inlineDynamicImports: true,
        banner: `window.__ModuleLoader__.load({ id: 'dsh-fusion', ${entry === "launcher" ? "" : `chunk: '${fileName}', `}factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
        footer: "return module.exports;\n}});",
      },
    },
  },
});
