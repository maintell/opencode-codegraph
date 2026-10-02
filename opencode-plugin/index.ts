/**
 * index.ts — opencode v2 plugin entry (scaffold for Tasks 3–4).
 *
 * Ruling 3 note: `@opencode/plugin` is NOT installed in this repo, so the
 * hook/API names below are written against the documented API (`Plugin.define`,
 * `ctx.tool.hook("execute.after", …)`, `ctx.event.subscribe({signal})`) and
 * are unverified against the real types until Task 3/4 build time. Do NOT add
 * `@opencode/plugin` as a dependency.
 */

import { flushSoon, noteEdit } from "./queue.ts";

const EDIT_TOOLS = new Set(["edit", "write", "patch"]);

function editedPaths(output: unknown): string[] {
  if (typeof output !== "object" || output === null) return [];
  const rec = output as Record<string, unknown>;
  const files = rec.files ?? rec.filePath ?? rec.path;
  const list = Array.isArray(files) ? files : files !== undefined ? [files] : [];
  return list.filter((f): f is string => typeof f === "string" && f.length > 0);
}

export const Plugin = {
  define(desc: { id: string; setup: (ctx: unknown) => void | (() => void) | Promise<void | (() => void)> }) {
    return desc;
  },
};

export default Plugin.define({
  id: "codegraph",
  async setup(ctx: any) {
    const c = new AbortController();

    await ctx.tool.hook("execute.after", async (output: any) => {
      if (!EDIT_TOOLS.has(output?.tool)) return;
      for (const f of editedPaths(output)) noteEdit(f);
      // Queues only, logs nothing.
    });

    // Idle-subscribe loop stub: Task 4 replaces the body with debounce flush.
    const sub: unknown =
      typeof ctx.event?.subscribe === "function"
        ? ctx.event.subscribe({ signal: c.signal })
        : null;
    void sub;
    flushSoon();

    return () => c.abort();
  },
});
