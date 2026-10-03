# codegraph — opencode v2 plugin

Code-graph index triggers + 7 live model tools for [opencode](https://opencode.ai) (v2 plugin API).
No `@opencode/plugin` dependency — the entry uses the documented `Plugin.define` shape only.

## Install

Pick one:

**A. Per-project (recommended for dev):** copy or symlink this folder to
`<project>/.opencode/plugins/codegraph/`:

```bash
cp -r opencode-plugin <project>/.opencode/plugins/codegraph
# or: ln -s <repo>/opencode-plugin <project>/.opencode/plugins/codegraph
```

**B. Global:** copy/symlink to `~/.config/opencode/plugins/codegraph/` (same layout).

**C. Path reference:** no copy — point `opencode.jsonc` at this folder:

```json
{ "plugins": ["./opencode-plugin"] }
```

See `opencode.jsonc.example` (repo root) for the minimal config.

## Binary resolution (`CODEGRAPH_BIN`)

The plugin shells out to a `codegraph` CLI binary per call. Resolution order:

1. `CODEGRAPH_BIN` env var (explicit override — use this for a source build:
   `CODEGRAPH_BIN=/path/to/target/release/code-graph-mcp`).
2. `codegraph` on `PATH`.
3. `<pluginRoot>/../bin/codegraph[.exe]` (bundled).
4. `~/.cache/code-graph/bin/`.

Missing binary is fail-open: tools return a `codegraph unavailable (no-binary)` hint, hooks stay silent.

## How indexing triggers

1. You edit a file → the `tool.execute.after` hook queues the path (`edit`/`write`/`patch` only; queue-only, no spawn).
2. On `session.idle`, the debounced flush (3 s) runs one
   `incremental-index --quiet --no-embed` when the queue is non-empty.
3. Session start runs one cold path: `health-check`, then `reindex --from-snapshot`
   when the index is missing, else `incremental-index` (non-blocking, background).
4. Session start also injects a `map --compact` snapshot (capped at 4000 bytes); empty when unindexed.

Lock contention (`database is locked`) is a silent no-op — the next idle retries.

## Tools (namespace `codegraph`)

| Tool | CLI equivalent | Use |
|------|----------------|-----|
| `semantic_code_search` | `search` | Fuzzy/concept search (plugin CLI: FTS-only) |
| `get_call_graph` | `callgraph` / `trace` | Callers/callees; `route_path` traces an HTTP route |
| `get_ast_node` | `show` | One symbol: signature + source + refs/impact |
| `project_map` | `map` | Architecture map (modules, deps, hot fns) |
| `module_overview` | `overview` | Symbols in a dir/file (`include_deps`/`include_dead` have no CLI flag — use `deps` / `dead-code`) |
| `ast_search` | `ast-search` | Typed symbol enumeration (type/returns/params) |
| `find_references` | `refs` | All references to a symbol |

Every model-tool call runs one short-lived CLI process (`runCodegraph` appends the single `--json`).

## No-popup + fail-open

- Every child spawn sets `windowsHide: true, shell: false, stdio: pipe` — no console window on Windows.
- Hooks never throw into the host; a failed run surfaces as content text, never an exception.
- A `grep|rg`-shaped bash command yields a prefer-codegraph hint only (input never mutated); `read`/`edit`-shaped input yields none.

## Verification

```bash
cargo build --release
node --test "opencode-plugin/*.test.js"   # glob form; bare dir form is broken
cargo test --lib
cargo clippy --all-targets -- -D warnings
```

Manual E2E (scratch repo under `F:/Temp/opencode`): full + incremental
`incremental-index`, `health-check`, one `--json` query per subcommand,
legacy `.code-graph/` migration, `reindex --from-snapshot` fallback.
Full command log: `.superpowers/sdd/2026-10-03-opencode-v2-plugin/task-5-report.md`.
