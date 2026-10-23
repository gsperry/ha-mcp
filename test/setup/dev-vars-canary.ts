// Runs in Node, not in the Worker runtime, and the project has no Node type
// definitions yet, so this file is excluded from type checking.
// @ts-nocheck
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const devVarsPath = resolve(import.meta.dirname, "../../.dev.vars");

// First line of the file this setup writes, so a canary left behind by a killed
// run is recognised as ours and not mistaken for a developer's real file.
const MARKER = "# canary written by the test setup; safe to delete";

let created = false;

function cleanup(): void {
  if (created) {
    rmSync(devVarsPath, { force: true });
    created = false;
  }
}

/**
 * Makes sure a `.dev.vars` file exists in the project root while tests run, so
 * the environment-isolation test always has something that could leak. A file
 * that is already there (a developer's real one) is never touched or removed;
 * only a file this setup created (or a marked canary left by a killed run) is
 * deleted afterwards.
 */
export default function setup(): () => void {
  const existing = existsSync(devVarsPath);
  const stale = existing && readFileSync(devVarsPath, "utf8").startsWith(MARKER);
  if (!existing || stale) {
    writeFileSync(devVarsPath, `${MARKER}\nHA_TOKEN=canary-token\nLEAK_CANARY=1\n`);
    created = true;
    // Also remove it if the process is interrupted before teardown runs.
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        cleanup();
        process.exit(1);
      });
    }
    process.once("exit", cleanup);
  }
  return cleanup;
}
