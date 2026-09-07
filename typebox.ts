/**
 * Dev-time resolution for the bare `typebox` specifier.
 *
 * omp hosts map `typebox` onto @oh-my-pi/omptype's TypeBox shim when they
 * load the extension. This re-export gives `tsc` and `bun build` in this
 * repository the exact same module: types come from the package's export
 * map (`dist/types/typebox.d.ts`), and Bun's `bun` condition compiles the
 * shim source directly. Not shipped in the npm tarball — consumers keep
 * importing the bare specifier, which the omp host resolves.
 */
export * from "@oh-my-pi/omptype/typebox.js";
