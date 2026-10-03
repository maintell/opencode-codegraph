/**
 * index.ts — opencode v2 plugin entry (scaffold for Task 4; tools wired by Task 3).
 *
 * Ruling 3 note: `@opencode/plugin` is NOT installed in this repo, so the
 * hook/API names below are written against the documented API (`Plugin.define`,
 * `ctx.tool.hook("execute.after", …)`, `ctx.tool.transform(editor => editor.add(…))`,
 * `ctx.event.subscribe({signal})`) and are unverified against the real types
 * until build time. Do NOT add `@opencode/plugin` as a dependency.
 */

import { flushSoon, noteEdit } from "./queue.ts";
import { TOOL_DEFINITIONS, executeTool } from "./tools.ts";

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

    // 7 live model tools (spec §5). One editor.add per tool, all under the
    // `codegraph` namespace, codemode off (short-lived CLI per call).
    await ctx.tool.transform((editor: any) => {
      for (const def of TOOL_DEFINITIONS) {
        const name = def.name;
        editor.add(
          {
            name,
            description: def.description,
            input_schema: def.input_schema,
          },
          {
            namespace: "codegraph",
            codemode: false,
            execute: (input: any, toolCtx: any) => executeTool(name, input, toolCtx?.signal),
          },
        );
      }
      return editor;
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
