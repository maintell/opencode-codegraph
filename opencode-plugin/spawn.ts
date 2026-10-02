/**
 * spawn.ts — hidden child-process defaults + short-lived CLI runner.
 *
 * Port of `claude-plugin/scripts/proc-opts.js:38` `hidden()`: every child
 * spawn sets `windowsHide: true, shell: false, stdio: pipe`; never
 * `detached: true`, `inherit`, or `cmd /c start`. `windowsHide: true` maps to
 * CREATE_NO_WINDOW (no-op on non-Windows); inherited stdio handles still work.
 */

import { execFileSync } from "node:child_process";
import { resolveBin } from "./binary.ts";

export function hidden(opts: Record<string, unknown> = {}): Record<string, unknown> {
  return { windowsHide: true, ...opts };
}

export interface RunResult {
  ok: boolean;
  stdout: string;
}

// Fail-open: missing binary / non-zero exit / timeout / abort all yield
// `{ok:false, stdout:""}` — the caller renders a hint. Never throws.
export function runCodegraph(args: string[], signal?: AbortSignal): RunResult {
  const bin = resolveBin();
  if (!bin) return { ok: false, stdout: "" };
  try {
    const out = execFileSync(bin, [...args, "--json"], {
      encoding: "utf8",
      ...hidden({ stdio: "pipe", shell: false, timeout: 15000, signal }),
    });
    return { ok: true, stdout: typeof out === "string" ? out : String(out) };
  } catch {
    return { ok: false, stdout: "" };
  }
}
