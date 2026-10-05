/**
 * index.ts — opencode v2 plugin entry (Task 4: all 4 hooks wired).
 *
 * Host shapes verified against the real types (2026-10-05):
 * - `@opencode/plugin/dist/promise/registration.d.ts`: `Hooks` callbacks are
 *   `(input) => Promise<void> | void` — return values are DROPPED, mutate the
 *   passed event object in place.
 * - `@opencode/plugin/dist/promise/tool.d.ts`: `execute.after` event is a
 *   single object `{tool, input, status, result|error}` (path lives on
 *   `event.input`, never on the result); `execute.before` event is
 *   `{tool, …, input}` with MUTABLE `input`.
 * - `@opencode/plugin/dist/promise/session.d.ts` + slim's `v2/types.d.ts`
 *   `V2SessionContextEvent`: `context` event carries MUTABLE
 *   `system: Array<{type:"text", text}>` — push parts in place.
 * - Client `SessionIdle{type:"session.idle"}`: idle name correct, loop as-is.
 * Do NOT add `@opencode/plugin` as a dependency (types only, read in place).
 */

import { beforeHookText, buildGrepHint, buildSessionContext } from "./hooks.ts";
import { ensureColdStart, flushSoon, noteEdit } from "./queue.ts";
import { runCodegraph } from "./spawn.ts";
import { TOOL_DEFINITIONS, executeTool } from "./tools.ts";

const EDIT_TOOLS = new Set(["edit", "write", "patch"]);

// Mirror of oh-my-opencode-slim's PATH_ARG_KEYS: the v2 after-event carries the
// file path on `event.input`, never on the result payload.
const PATH_ARG_KEYS = ["filePath", "path"] as const;

function inputPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const rec = input as Record<string, unknown>;
  for (const key of PATH_ARG_KEYS) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return [v];
    if (Array.isArray(v)) {
      const out = v.filter((f): f is string => typeof f === "string" && f.length > 0);
      if (out.length > 0) return out;
    }
  }
  return [];
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

    // v2 host: single event object {tool, input, result/error, status}.
    // `input` is authoritative for the path (result payload has no files).
    await ctx.tool.hook("execute.after", async (event: any) => {
      try {
        if (!EDIT_TOOLS.has(event?.tool)) return;
        if (event?.status && event.status !== "completed") return;
        for (const f of inputPaths(event?.input)) noteEdit(f);
        // Queues only, logs nothing. No spawn.
      } catch {
        // Fail-open: queue errors never throw into the host.
      }
    });

    // Hint-only: v2 host `Hooks` callbacks return void — the hint is appended
    // to the bash command in place (bridge pattern: `event.input = out.args`).
    // Bash gate: beforeHookText only returns text for bash-shaped events
    // (tool==="bash", or a `command` string when the event carries no tool
    // name); a codegraph tool input mentioning grep never reaches
    // buildGrepHint. Input otherwise NEVER mutated.
    await ctx.tool.hook("execute.before", async (event: any) => {
      try {
        const text = beforeHookText(event);
        if (text === null) return;
        const hint = buildGrepHint(text);
        if (!hint) return;
        const input = event?.input;
        if (typeof input === "object" && input !== null && typeof (input as Record<string, unknown>).command === "string") {
          (input as Record<string, unknown>).command = `${(input as Record<string, unknown>).command} # ${hint}`;
        } else if (typeof input === "string" && input.length > 0) {
          event.input = `${input} # ${hint}`;
        } else if (typeof event?.command === "string") {
          event.command = `${event.command} # ${hint}`;
        }
        // ponytail: host may not re-read a rewritten command string — if the
        // hint never surfaces, drop the before-hook (queue+context remain).
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

    // Session start: cold `map --compact` injection via in-place
    // `event.system` push ({type:"text", text} parts, capped at 4000 bytes);
    // `no_index`/binary-missing → append nothing (silent). Host `Hooks`
    // callbacks return void — never `return {context}`.
    if (typeof ctx.session?.hook === "function") {
      await ctx.session.hook("context", async (event: any) => {
        try {
          const text = buildSessionContext((args) => runCodegraph(args, c.signal));
          if (!text) return;
          if (Array.isArray(event?.system)) {
            event.system.push({ type: "text", text });
          }
        } catch {
          // silent
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
