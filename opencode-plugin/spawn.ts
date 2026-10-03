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
// `{ok:false, ...}` — the caller renders a hint. Never throws. On failure the
// child's stderr/stdout text (Usage lines, `database is locked`, `No index
// found`) is returned as `stdout` (capped ~2000 chars) so `executeTool`'s
// substring gates see it (refusal-as-content); textless failures keep
// `stdout:""`.
export function runCodegraph(args: string[], signal?: AbortSignal): RunResult {
  const bin = resolveBin();
  if (!bin) return { ok: false, stdout: "" };
  try {
    const out = execFileSync(bin, [...args, "--json"], {
      encoding: "utf8",
      ...hidden({ stdio: "pipe", shell: false, timeout: 15000, signal }),
    });
    return { ok: true, stdout: typeof out === "string" ? out : String(out) };
  } catch (err) {
    return { ok: false, stdout: failText(err) };
  }
}

// execFileSync errors carry the child's partial stdout/stderr (strings when
// `encoding` is set, Buffers otherwise). Join stdout+stderr, cap ~2000 chars.
// Never throws.
function failText(err: unknown): string {
  try {
    const e = err as { stdout?: unknown; stderr?: unknown } | null;
    const chunks: string[] = [];
    for (const v of [e?.stdout, e?.stderr]) {
      if (typeof v === "string") chunks.push(v);
      else if (v instanceof Uint8Array) chunks.push(Buffer.from(v).toString("utf8"));
    }
    return chunks.join("\n").trim().slice(0, 2000);
  } catch {
    return "";
  }
}
