/**
 * Vitest resolves the omp runtime packages' TypeScript source, which imports
 * Bun-only modules (`bun`, `bun:ffi`, `bun:sqlite`, ...). None of those code
 * paths run in this suite; these inert stubs only satisfy module resolution
 * under Node workers. Every callable fails loudly if a test ever reaches it.
 */
export const plugin = (): void => {
  throw new Error("bun plugin() is not available under Vitest");
};

export class Glob {
  constructor(
    public readonly pattern: string,
    public readonly input: string = ".",
  ) { }
  scan(): never {
    throw new Error("bun Glob is not available under Vitest");
  }
  scanSync(): never {
    throw new Error("bun Glob is not available under Vitest");
  }
}

export const YAML = {
  parse(): never {
    throw new Error("bun YAML is not available under Vitest");
  },
  stringify(): never {
    throw new Error("bun YAML is not available under Vitest");
  },
};

export const dlopen = (): never => {
  throw new Error("bun:ffi dlopen is not available under Vitest");
};

export const CString = (): never => {
  throw new Error("bun:ffi CString is not available under Vitest");
};

export const ptr = (): never => {
  throw new Error("bun:ffi ptr is not available under Vitest");
};

export const FFIType: Record<string, string> = {};

export class Database {
  constructor(..._args: unknown[]) {
    throw new Error("bun:sqlite Database is not available under Vitest");
  }
}

export const startRemoteDebugger = (): void => {
  throw new Error("bun:jsc startRemoteDebugger is not available under Vitest");
};
