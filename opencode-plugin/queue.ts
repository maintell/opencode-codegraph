/**
 * queue.ts — in-memory edit queue (dedupe, FIFO cap) + debounced idle flush.
 *
 * `noteEdit()` / `takePending()` back the `tool.execute.after`
 * (edit/write/patch) hook in `index.ts`: hooks queue file paths only and
 * never spawn. `flushSoon()` debounces (3s prod) then runs one
 * `incremental-index --quiet --no-embed` via `runCodegraph` when the queue
 * is non-empty; `ok:false`/throw re-queues the drained files (next idle
 * retries). `ensureColdStart()` runs the once-per-session `health-check` /
 * `reindex --from-snapshot` cold path. All fail-open: never throws.
 *
 * Test hook: `__testReset()` clears timer + queue + cold-start guard and
 * shortens the debounce to 10ms so `node:test`'s ~100ms wait suffices.
 * Production default stays 3000ms (Ruling 1: debounce `setTimeout`
 * permitted; no `setInterval` anywhere).
 */

import { runCodegraph, type RunResult } from "./spawn.ts";

const MAX_PENDING = 500;

const pending = new Set<string>();

export function noteEdit(filePath: string): void {
  if (!filePath) return;
  if (pending.has(filePath)) return;
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.values().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.add(filePath);
}

export function takePending(): string[] {
  const out = [...pending];
  pending.clear();
  return out;
}

let coldDone = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Test override: `__testReset()` shortens the debounce so `node:test`'s
// ~100ms wait suffices. Production default stays 3000ms.
let testDebounceMs: number | null = null;

export function flushSoon(
  run: (args: string[]) => RunResult = runCodegraph,
): void {
  // Debounce: coalesce rapid calls into one flush. Test-tuned via env
  // (Ruling 1 permits this `setTimeout`; `setInterval` forbidden).
  const delay =
    testDebounceMs ??
    (process.env.CODEGRAPH_FLUSH_DEBOUNCE_MS
      ? Number(process.env.CODEGRAPH_FLUSH_DEBOUNCE_MS)
      : 3000);
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      flushNow(run);
    } catch {
      // Fail-open: flush errors never throw into the host.
    }
  }, delay);
  // `unref` in the real plugin so the debounce never holds the host open.
  // Guarded: fake-timer tests provide handle-likes without `unref`.
  const t = flushTimer as unknown as { unref?: () => void };
  try {
    t?.unref?.();
  } catch {
    // ignore
  }
}

// Immediate flush: drains the queue; non-empty → one incremental-index.
// `ok:false` or throw → re-queue the drained files (via noteEdit, so the
// MAX_PENDING cap still applies) so the next idle retries. Empty queue →
// 0 runs. Never throws.
export function flushNow(run: (args: string[]) => RunResult = runCodegraph): void {
  let files: string[];
  try {
    files = takePending();
  } catch {
    return;
  }
  if (files.length === 0) return;
  let ok = false;
  try {
    ok = run(["incremental-index", "--quiet", "--no-embed"])?.ok === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    // Re-queue drained files in original order so the retry sees the same
    // FIFO (via noteEdit so the MAX_PENDING cap still applies).
    for (const f of files) noteEdit(f);
  }
}

// Cold path: `health-check` reports `no_index` → `reindex --from-snapshot`
// once per session (module-level guard); else plain `incremental-index`
// (full-builds when DB absent; Task 1 migration runs inside it).
export function ensureColdStart(
  run: (args: string[]) => RunResult = runCodegraph,
): void {
  if (coldDone) return;
  coldDone = true;
  try {
    const hc = run(["health-check"]);
    if (hc?.ok && /no_index/i.test(hc.stdout ?? "")) {
      run(["reindex", "--from-snapshot", "--quiet", "--no-embed"]);
    } else {
      run(["incremental-index", "--quiet", "--no-embed"]);
    }
  } catch {
    // silent
  }
}

export function __testReset(): void {
  takePending();
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  coldDone = false;
  testDebounceMs = 10;
}
