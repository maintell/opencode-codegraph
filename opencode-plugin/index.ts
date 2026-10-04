/**
 * index.ts — opencode v2 plugin entry (Task 4: all 4 hooks wired).
 *
 * Ruling 3 note: `@opencode/plugin` is NOT installed in this repo, so the
 * hook/API names below are written against the documented API (`Plugin.define`,
 * `ctx.tool.hook("execute.after"/"execute.before", …)`,
 * `ctx.tool.transform(editor => editor.add(…))`,
 * `ctx.event.subscribe({signal})`, `ctx.session.hook("context", …)`) and are
 * unverified against the real types until build time. Do NOT add
 * `@opencode/plugin` as a dependency.
 */

import { beforeHookText, buildGrepHint, buildSessionContext, capBytes } from "./hooks.ts";
import { ensureColdStart, flushSoon, noteEdit } from "./queue.ts";
import { runCodegraph } from "./spawn.ts";
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

    // Warm queue: cold-start once (health-check / snapshot / full) in the
    // background so setup() returns immediately (execFileSync blocks up to
    // 2x15s worst case). Fire-and-forget, fail-open: never throws.
    void (async () => {
      await null; // yield first: setup() keeps running/returns, cold start resumes next microtask
      try {
        ensureColdStart();
      } catch {
        // silent
      }
    })();

    await ctx.tool.hook("execute.after", async (output: any) => {
      try {
        if (!EDIT_TOOLS.has(output?.tool)) return;
        for (const f of editedPaths(output)) noteEdit(f);
        // Queues only, logs nothing. No spawn.
      } catch {
        // Fail-open: queue errors never throw into the host.
      }
    });

    // Hint-only: grep|rg-like bash input → prefer-codegraph hint as
    // context text. Bash gate: beforeHookText only returns text for
    // bash-shaped events (tool==="bash", or a `command` string when the
    // event carries no tool name); a codegraph tool input mentioning grep
    // never reaches buildGrepHint. Input NEVER mutated.
    await ctx.tool.hook("execute.before", async (input: any) => {
      try {
        const text = beforeHookText(input);
        if (text === null) return;
        const hint = buildGrepHint(text);
        if (hint) return { context: hint };
      } catch {
        // silent
      }
    });

    // 7 live model tools (spec §5). One editor.add per tool, all under the
    // `codegraph` namespace, codemode off (short-lived CLI per call).
    await ctx.tool.transform((editor: any) => {
      for (const def of TOOL_DEFINITIONS) {
        const name = def.name;
        editor.add({
          name,
          description: def.description,
          input: def.input_schema,
          options: { namespace: "codegraph", codemode: false },
          execute: (input: any, toolCtx: any) => executeTool(name, input, toolCtx?.signal),
        });
      }
      return editor;
    });

    // Session start: cold `map --compact` injection capped at 4000 bytes;
    // `no_index`/binary-missing → append nothing (silent).
    if (typeof ctx.session?.hook === "function") {
      await ctx.session.hook("context", async () => {
        try {
          const text = buildSessionContext((args) => runCodegraph(args, c.signal));
          return text ? { context: capBytes(text, 4000) } : undefined;
        } catch {
          return undefined;
        }
      });
    }

    // Idle loop: every `session.idle` event → debounced flush (Task 4
    // rewire of the Task 2 stub; fire-and-forget, host aborts on cleanup).
    if (typeof ctx.event?.subscribe === "function") {
      void (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: c.signal })) {
            try {
              if ((ev as any)?.type === "session.idle") flushSoon();
            } catch {
              // silent; next idle retries
            }
          }
        } catch {
          // subscribe abort/close: silent
        }
      })();
    }

    return () => c.abort();
  },
});
