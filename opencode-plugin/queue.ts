/**
 * queue.ts — in-memory edit queue (dedupe, FIFO cap) + flush placeholder.
 *
 * `noteEdit()` / `takePending()` back the `tool.execute.after`
 * (edit/write/patch) hook in `index.ts`: hooks queue file paths only and
 * never spawn. Task 4 fills `flushSoon()` with the debounce + idle flush.
 */

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

export function flushSoon(): void {
  // Task 4: debounce + session.idle incremental-index flush goes here.
}
