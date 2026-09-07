import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

// omp hosts map the bare `typebox` specifier onto the bundled omptype
// TypeBox shim; tsconfig paths mirror that for typechecking and this alias
// mirrors it for Vitest so tests exercise the same schema builders.
//
// The omp runtime packages publish Bun-oriented TypeScript source. Vitest
// runs them in Node workers: test/bun-shim.ts provides the small `Bun`
// global surface they use, the plugin below satisfies their Bun-only module
// imports (`bun`, `bun:ffi`, ...) whose scheme bypasses resolve.alias, and
// the inlined pi-natives package gets `import.meta.dir` (a Bun global
// Vitest does not define) pointed at the installed native addon directory.
const nativesNativeDir = fileURLToPath(
  new URL("./node_modules/@oh-my-pi/pi-natives/native", import.meta.url),
);
const bunModuleStub = fileURLToPath(
  new URL("./test/bun-module-stub.ts", import.meta.url),
);

const bunBuiltinStub: Plugin = {
  name: "omp-bun-builtin-stub",
  enforce: "pre",
  resolveId(source) {
    if (source === "bun" || source.startsWith("bun:")) return bunModuleStub;
    return null;
  },
};

export default defineConfig({
  plugins: [bunBuiltinStub],
  define: {
    "import.meta.dir": JSON.stringify(nativesNativeDir),
  },
  resolve: {
    alias: [{ find: "typebox", replacement: "@oh-my-pi/omptype/typebox" }],
  },
  test: {
    setupFiles: ["./test/bun-shim.ts"],
    server: {
      deps: {
        inline: [/@oh-my-pi\/pi-natives/],
      },
    },
  },
});
