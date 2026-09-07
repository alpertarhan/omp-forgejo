import { visibleWidth } from "@oh-my-pi/pi-natives";

/**
 * The omp runtime packages (@oh-my-pi/pi-tui, @oh-my-pi/pi-utils) publish
 * TypeScript source that runs under Bun, and Vitest executes them in Node
 * workers where the `Bun` global does not exist. Provide the small surface
 * those packages touch on the paths this suite exercises; width measurement
 * delegates to the real native addon so rendering assertions keep host
 * semantics.
 */
type BunShim = {
  env: NodeJS.ProcessEnv;
  stringWidth: (text: string) => number;
  stripANSI: (text: string) => string;
};

const holder = globalThis as { Bun?: BunShim };
if (holder.Bun === undefined) {
  holder.Bun = {
    env: process.env,
    stringWidth: (text) => visibleWidth(text, 3),
    stripANSI: (text) =>
      text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PRZcf-nqry=><]/g, ""),
  };
}
