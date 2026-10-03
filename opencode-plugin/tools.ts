/**
 * tools.ts — the 7 live model tools (mirror of `domain::LIVE_MCP_TOOLS`).
 *
 * Descriptions + `input_schema.properties` copied verbatim from
 * `src/mcp/tools.rs:45-229` (Ruling 2: `semantic_code_search` carries the
 * ` (plugin CLI: FTS-only)` suffix; `format!` range hints resolved against
 * `COUNT_RANGES`: depth 1-10, top_k/limit 1-100, similar_top_k 1-50,
 * context_lines 0-100, centrality_limit 1-100, deps_depth 1-10,
 * max_tokens range 100-100000; `TYPE_FILTER_HELP` =
 * `fn, class, struct, enum, trait, type, const, var`).
 *
 * Transport note: `TOOL_CLI_MAP` argv NEVER contains `--json` — single
 * ownership sits with Task 2 `runCodegraph`, which appends exactly one
 * `--json` (clap `SetTrue` flags error on duplicates). The refusal path
 * (`get_call_graph {}` → `["callgraph"]`) still surfaces: the CLI exits 1
 * with a Usage line and `executeTool` renders it as content.
 *
 * No new spawn code here: everything runs through `runCodegraph`.
 */

import { resolveBin } from "./binary.ts";
import { runCodegraph } from "./spawn.ts";

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

// Ruling 2 suffix: CLI `search` is FTS-only, no vector+RRF fusion.
const SEARCH_SUFFIX = " (plugin CLI: FTS-only)";

const MAX_TOKENS_DESC =
  "Token cap (bytes/3, range 100-100000): least-called items shrink, then drop; budget.next returns them";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "semantic_code_search",
    description:
      "Concept search (vector + FTS RRF). Use INSTEAD OF multi-round Grep when query is fuzzy / no exact symbol. Named symbol → get_ast_node; known module path → module_overview." +
      SEARCH_SUFFIX,
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        top_k: {
          type: "integer",
          description: "Results count (default 20, range 1-100). Alias: limit",
        },
        limit: {
          type: "integer",
          description:
            "Alias for top_k (default 20, range 1-100); read only when top_k is absent, and discarded in silence when both are sent",
        },
        language: { type: "string", description: "Filter by language" },
        node_type: { type: "string", description: "Filter by node type" },
        compact: {
          type: "boolean",
          description: "Compact mode: signature+location only, no code (saves tokens)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_call_graph",
    description:
      "Multi-hop call chain. Replaces N rounds of `grep \"X(\"` + Read. Pass route_path='GET /api/x' to trace HTTP handler → downstream.",
    input_schema: {
      type: "object",
      properties: {
        symbol_name: {
          type: "string",
          description:
            "Function/method name. A call must carry symbol_name or route_path (mutually exclusive); a call naming neither is refused.",
        },
        route_path: {
          type: "string",
          description:
            "HTTP route like 'GET /api/users' — traces from matched route handler(s) down. Mutually exclusive with symbol_name.",
        },
        direction: {
          type: "string",
          enum: ["callers", "callees", "both"],
          description: "Direction (default 'both'); ignored when route_path is set (always 'callees')",
        },
        depth: {
          type: "integer",
          description:
            "Max depth (default 3, range 1-10); a larger value is clamped, and a successful response says so in clamped_arguments",
        },
        file_path: { type: "string", description: "Disambiguate same-name functions" },
        include_middleware: {
          type: "boolean",
          description: "For route_path mode: include downstream middleware/calls (default true)",
        },
        compact: {
          type: "boolean",
          description: "Compact mode: name+file+depth only (saves tokens)",
        },
        include_tests: { type: "boolean", description: "Include test callers (default false)" },
        min_confidence: {
          type: "string",
          enum: ["extracted", "inferred", "ambiguous"],
          description:
            "Min edge confidence to FOLLOW (default 'inferred'): hides 'ambiguous' by-name fan-out — a method name shared by many defs that resolves to all of them (e.g. `.execute()` → every execute). Pass 'ambiguous' to include every edge; 'extracted' for same-file-precise only. `ambiguous_edges_hidden` in the response counts what was suppressed.",
        },
        max_tokens: { type: "integer", description: MAX_TOKENS_DESC },
      },
      required: [],
    },
  },
  {
    name: "get_ast_node",
    description:
      "ONE named symbol: signature + source + opt impact/refs/similar. Use BEFORE editing X to see signature + blast radius.",
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "File path (with symbol_name)" },
        symbol_name: {
          type: "string",
          description:
            "Symbol name (with file_path, or alone for auto-resolve). A call must carry symbol_name or node_id — file_path alone names a file, not a symbol, and is refused. So is a name with several definitions in the one file (cfg-gated alternates, overloads, repeated headings): the reply lists their node_ids, pick one.",
        },
        node_id: { type: "integer", description: "Node ID (alternative to file_path+symbol_name)" },
        include_references: {
          type: "boolean",
          description: "Include callers/callees (default false)",
        },
        include_tests: {
          type: "boolean",
          description: "Include test callers in references (default false)",
        },
        include_impact: {
          type: "boolean",
          description:
            "Include impact summary: risk level, caller count, affected files/routes (default false)",
        },
        min_confidence: {
          type: "string",
          enum: ["extracted", "inferred", "ambiguous"],
          description:
            "For include_impact: min caller-edge confidence counted toward risk (default 'inferred'). Folds the ambiguous by-name fan-out (a name shared by many defs) out of the blast radius; pass 'ambiguous' to count every resolved caller. `impact.ambiguous_callers_excluded` discloses what was folded.",
        },
        include_similar: {
          type: "boolean",
          description:
            "Include embedding-similar nodes (default false; requires embed-model + indexed embeddings)",
        },
        similar_top_k: {
          type: "integer",
          description: "With include_similar: max similar results (default 5, range 1-50)",
        },
        context_lines: {
          type: "integer",
          description:
            "Surrounding source lines to include (default 0, default 3 when using node_id; range 0-100)",
        },
        compact: {
          type: "boolean",
          description: "Compact mode: type+signature+location only, no code_content (saves tokens)",
        },
        max_tokens: { type: "integer", description: MAX_TOKENS_DESC },
      },
      required: [],
    },
  },
  {
    name: "project_map",
    description:
      "Architecture map (modules / deps / hot fns; include_centrality=chokepoints). Replaces Glob+Read of N top-level files. Use when orienting in an unfamiliar repo or after a major refactor.",
    input_schema: {
      type: "object",
      properties: {
        compact: {
          type: "boolean",
          description:
            "Compact mode: paths+counts+key_symbols, trimmed hot_functions (saves tokens)",
        },
        include_centrality: {
          type: "boolean",
          description:
            "Include architectural chokepoints (betweenness centrality — functions on the most shortest call paths; high score = structural bridge). Default false.",
        },
        centrality_limit: {
          type: "integer",
          description: "With include_centrality: max ranked results (default 10, range 1-100)",
        },
        max_tokens: { type: "integer", description: MAX_TOKENS_DESC },
      },
      required: [],
    },
  },
  {
    name: "module_overview",
    description:
      "Symbols in a directory or file, grouped by type + caller count. Replaces Glob + Read×N for big dirs / huge files. Single file: include_deps=dep graph, include_dead=unreferenced.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File or directory path (e.g. 'src/auth/')" },
        compact: {
          type: "boolean",
          description: "Compact mode: name+type+callers only, no signatures (saves tokens)",
        },
        include_deps: {
          type: "boolean",
          description:
            "When path is a single file: include outgoing/incoming file dependencies (default false)",
        },
        deps_direction: {
          type: "string",
          enum: ["outgoing", "incoming", "both"],
          description: "With include_deps: direction filter (default 'both')",
        },
        deps_depth: {
          type: "integer",
          description: "With include_deps: max transitive depth (default 2, range 1-10)",
        },
        include_dead: {
          type: "boolean",
          description:
            "Include unreferenced symbols (orphans + exported-unused) under this path (default false). Macro/shell-invoked entry points are pre-filtered. Results are candidates to verify: receiver-method calls (obj.method()) and cross-file const/type uses are not edge-tracked, so a flagged symbol may still be used.",
        },
        dead_min_lines: {
          type: "integer",
          description: "With include_dead: min line count to flag (default 3)",
        },
        max_tokens: { type: "integer", description: MAX_TOKENS_DESC },
      },
      required: ["path"],
    },
  },
  {
    name: "ast_search",
    description:
      "Enumerate symbols by typed filters (type/returns/params) Grep can't express. Use for 'all fns returning Result<T>' / 'all structs implementing X'. ONE known symbol → get_ast_node.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search text. A call must carry query or at least one of type / returns / params; a bare limit is refused.",
        },
        type: {
          type: "string",
          description:
            "Node type: fn, class, struct, enum, trait, type, const, var (interface = trait)",
        },
        returns: { type: "string", description: "Return type substring filter" },
        params: { type: "string", description: "Parameter text substring filter" },
        limit: {
          type: "integer",
          description: "Max results (default 20, range 1-100)",
        },
      },
      required: [],
    },
  },
  {
    name: "find_references",
    description:
      "Rename/remove audits — every site that imports/inherits/implements/calls a symbol, across languages; Grep after it for dynamic uses. Literals → Grep; 'who calls X?' → get_call_graph.",
    input_schema: {
      type: "object",
      properties: {
        symbol_name: {
          type: "string",
          description:
            "Symbol to find references for. A call must carry symbol_name or node_id; a call naming neither is refused.",
        },
        node_id: {
          type: "integer",
          description:
            "Exact node from a prior suggestion — overrides symbol_name. Use to disambiguate same-name defs in one file.",
        },
        file_path: { type: "string", description: "Disambiguate same-name symbols across files" },
        relation: {
          type: "string",
          enum: ["calls", "imports", "inherits", "implements", "references", "exports", "routes_to", "all"],
          description: "Relation type filter (default 'all')",
        },
        include_tests: {
          type: "boolean",
          description:
            "Include references from test code (default true — tests are usage sites for rename audits). Set false to see production callers only.",
        },
        min_confidence: {
          type: "string",
          enum: ["extracted", "inferred", "ambiguous"],
          description:
            "Min edge confidence to KEEP. Default: no floor — every reference is returned, each tagged with its own `confidence` ('extracted' = same-file precise, 'inferred' = import-resolved, 'ambiguous' = by-name fan-out that may point at a same-named symbol elsewhere). Pass 'inferred' to drop the ambiguous tier; `confidence_filtered` in the response counts what was dropped.",
        },
        compact: {
          type: "boolean",
          description:
            "Compact mode: name+file+relation+confidence+node_id only, no code or signature (saves tokens)",
        },
      },
      required: [],
    },
  },
];

export type ToolInput = Record<string, unknown>;

// Empty/whitespace-only strings are absent (mirrors the Rust `nonblank` guard:
// an empty symbol would otherwise fuzzy-match a random candidate).
function str(input: ToolInput, key: string): string | null {
  const v = input[key];
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function num(input: ToolInput, key: string): number | null {
  const v = input[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function flag(input: ToolInput, key: string): boolean {
  return input[key] === true;
}

function pushFlag(argv: string[], on: boolean, f: string): void {
  if (on) argv.push(f);
}

function pushOpt(argv: string[], value: string | null, f: string): void {
  if (value !== null) argv.push(f, value);
}

function clampLimit(n: number | null): string | null {
  if (n === null) return null;
  return String(Math.min(100, Math.max(1, Math.trunc(n))));
}

function searchArgs(input: ToolInput): string[] {
  const argv: string[] = ["search"];
  const q = str(input, "query");
  if (q !== null) argv.push(q);
  pushFlag(argv, flag(input, "compact"), "--compact");
  pushOpt(argv, str(input, "language"), "--language");
  pushOpt(argv, str(input, "node_type"), "--node-type");
  // `--limit` alias `--top-k`: top_k wins when both are sent.
  const limit = clampLimit(num(input, "top_k") ?? num(input, "limit"));
  if (limit !== null) argv.push("--limit", limit);
  return argv;
}

function callgraphArgs(input: ToolInput): string[] {
  const route = str(input, "route_path");
  if (route !== null) {
    // Route mode folds the old trace_http_chain tool (v0.18.4).
    const argv: string[] = ["trace", route];
    const depth = num(input, "depth");
    if (depth !== null) argv.push("--depth", String(Math.trunc(depth)));
    if (input["include_middleware"] === false) argv.push("--no-middleware");
    pushFlag(argv, flag(input, "include_tests"), "--include-tests");
    pushOpt(argv, str(input, "min_confidence"), "--min-confidence");
    return argv;
  }
  const argv: string[] = ["callgraph"];
  // Legacy alias, like the MCP handler's `function_name` fallback.
  const symbol = str(input, "symbol_name") ?? str(input, "function_name");
  if (symbol !== null) argv.push(symbol);
  const nodeId = num(input, "node_id");
  if (nodeId !== null) argv.push("--node-id", String(Math.trunc(nodeId)));
  pushOpt(argv, str(input, "direction"), "--direction");
  const depth = num(input, "depth");
  if (depth !== null) argv.push("--depth", String(Math.trunc(depth)));
  pushOpt(argv, str(input, "file_path"), "--file");
  pushOpt(argv, str(input, "min_confidence"), "--min-confidence");
  pushFlag(argv, flag(input, "include_tests"), "--include-tests");
  pushFlag(argv, flag(input, "compact"), "--compact");
  return argv;
}

function showArgs(input: ToolInput): string[] {
  const argv: string[] = ["show"];
  const symbol = str(input, "symbol_name");
  if (symbol !== null) argv.push(symbol);
  const nodeId = num(input, "node_id");
  if (nodeId !== null) argv.push("--node-id", String(Math.trunc(nodeId)));
  pushOpt(argv, str(input, "file_path"), "--file");
  pushFlag(argv, flag(input, "include_references"), "--refs");
  pushFlag(argv, flag(input, "include_impact"), "--impact");
  pushFlag(argv, flag(input, "include_tests"), "--include-tests");
  const ctx = num(input, "context_lines");
  if (ctx !== null) argv.push("--context-lines", String(Math.trunc(ctx)));
  pushFlag(argv, flag(input, "compact"), "--compact");
  return argv;
}

function mapArgs(input: ToolInput): string[] {
  const argv: string[] = ["map"];
  pushFlag(argv, flag(input, "compact"), "--compact");
  return argv;
}

function overviewArgs(input: ToolInput): string[] {
  const argv: string[] = ["overview"];
  const p = str(input, "path");
  if (p !== null) argv.push(p);
  pushFlag(argv, flag(input, "compact"), "--compact");
  return argv;
}

function astSearchArgs(input: ToolInput): string[] {
  const argv: string[] = ["ast-search"];
  const q = str(input, "query");
  if (q !== null) argv.push(q);
  pushOpt(argv, str(input, "type"), "--type");
  pushOpt(argv, str(input, "returns"), "--returns");
  pushOpt(argv, str(input, "params"), "--params");
  const limit = num(input, "limit");
  if (limit !== null) argv.push("--limit", String(Math.trunc(limit)));
  return argv;
}

function refsArgs(input: ToolInput): string[] {
  const argv: string[] = ["refs"];
  const symbol = str(input, "symbol_name");
  if (symbol !== null) argv.push(symbol);
  const nodeId = num(input, "node_id");
  if (nodeId !== null) argv.push("--node-id", String(Math.trunc(nodeId)));
  pushOpt(argv, str(input, "file_path"), "--file");
  pushOpt(argv, str(input, "relation"), "--relation");
  pushOpt(argv, str(input, "min_confidence"), "--min-confidence");
  pushFlag(argv, flag(input, "compact"), "--compact");
  return argv;
}

// Exact argv per tool (flags verified against the CLI structs in
// `src/cli/commands/`). No `--json` here — `runCodegraph` appends the single
// copy (Task 2 contract).
export const TOOL_CLI_MAP: Record<string, (input: ToolInput) => string[]> = {
  semantic_code_search: searchArgs,
  get_call_graph: callgraphArgs,
  get_ast_node: showArgs,
  project_map: mapArgs,
  module_overview: overviewArgs,
  ast_search: astSearchArgs,
  find_references: refsArgs,
};

// Props with NO CLI bare equivalent get an overviewHint-style suffix instead
// of an invented flag (no schema change; spec §5 required arrays as-is):
// - module_overview `include_deps`/`include_dead` → `deps` / `dead-code`
// - find_references `include_tests` → nothing: `refs` has no --include-tests
//   flag and ALWAYS includes test references (rollup called with
//   skip_tests=false in `src/cli/commands/refs.rs`), so `false` in particular
//   is silently not-a-filter without this note
// - project_map `include_centrality`/`centrality_limit` → `centrality`
// - `max_tokens` (callgraph/show/map/overview) → nothing passable: the CLI's
//   `--budget` conflicts with `--json`, which this transport always appends
function droppedHint(toolName: string, input: ToolInput): string {
  const notes: string[] = [];
  if (toolName === "module_overview" && (flag(input, "include_deps") || flag(input, "include_dead"))) {
    notes.push(
      "include_deps/include_dead have no CLI equivalent and were not applied — use the `deps` / `dead-code` CLI subcommands for those views",
    );
  }
  if (toolName === "find_references" && input["include_tests"] !== undefined) {
    notes.push(
      "include_tests has no CLI equivalent and was not applied — refs always includes test references",
    );
  }
  if (
    toolName === "project_map" &&
    (flag(input, "include_centrality") || input["centrality_limit"] !== undefined)
  ) {
    notes.push(
      "include_centrality/centrality_limit have no CLI equivalent and were not applied — use the `centrality` CLI subcommand for chokepoints",
    );
  }
  if (
    (toolName === "get_call_graph" ||
      toolName === "get_ast_node" ||
      toolName === "project_map" ||
      toolName === "module_overview") &&
    input["max_tokens"] !== undefined
  ) {
    notes.push(
      "max_tokens has no CLI equivalent and was not applied (the CLI --budget flag conflicts with --json)",
    );
  }
  if (
    toolName === "get_ast_node" &&
    (flag(input, "include_similar") || input["similar_top_k"] !== undefined)
  ) {
    notes.push(
      "include_similar/similar_top_k have no CLI equivalent and were not applied — embedding-similar needs the MCP path",
    );
  }
  if (notes.length === 0) return "";
  return `\n[codegraph hint: ${notes.join("; ")}]`;
}

function unavailable(reason: string, hint: string): { content: string } {
  return { content: `codegraph unavailable (${reason}): ${hint}` };
}

// Fail-open tool runner (Task 4 consumes this name verbatim). Never throws:
// `ok:false` becomes a content hint; CLI refusal text (non-empty stdout with
// `ok:false`, e.g. Usage lines or the `{"error":…}` envelope clap prints for
// flag errors) passes through verbatim.
export async function executeTool(
  toolName: string,
  input: ToolInput,
  signal?: AbortSignal,
): Promise<{ content: string }> {
  try {
    const build = TOOL_CLI_MAP[toolName];
    if (!build) return unavailable("run-failed", `unknown tool '${toolName}'`);
    const argv = build(input ?? {});
    const r = runCodegraph(argv, signal);
    if (r.ok) return { content: r.stdout + droppedHint(toolName, input) };
    if (r.stdout) {
      const text = r.stdout;
      if (/database is locked/i.test(text)) return unavailable("locked", text);
      if (/no[-_ ]?index/i.test(text)) return unavailable("no-index", text);
      return { content: text };
    }
    // Empty-stdout failure: only the binary question is answerable through
    // `runCodegraph`'s `{ok, stdout}` (no stderr / error-kind propagation, so
    // `timeout` folds into run-failed — see report).
    try {
      if (!resolveBin()) {
        return unavailable("no-binary", "no codegraph binary found (CODEGRAPH_BIN, PATH, bundled bin/, cache)");
      }
    } catch {
      return unavailable("no-binary", "binary resolution failed");
    }
    return unavailable("run-failed", "check CODEGRAPH_BIN and index state");
  } catch {
    return unavailable("run-failed", "check CODEGRAPH_BIN and index state");
  }
}
