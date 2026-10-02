# opencode v2 Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opencode v2 in-process plugin (thin TS + short-lived Rust CLI) storing per-project DBs in `<root>/.codegraph/`, with zero timers and zero popup windows.

**Architecture:** Rust keeps all indexing/query/snapshot logic; only the data-dir name changes with read-compat for the old dir. New `opencode-plugin/` TS package registers 7 model tools via `ctx.tool.transform` and drives `incremental-index --quiet --no-embed --json` from `tool.execute.after` + `session.idle` flush. Every spawn goes through a `hidden()` wrapper.

**Tech Stack:** Rust (clap CLI, rusqlite), TypeScript on Bun/Node (`@opencode/plugin`), `node:child_process execFileSync`.

**Spec:** `docs/superpowers/specs/2026-10-02-opencode-v2-plugin-design.md` (committed `fbaf41b`; note: file is gitignored, added with `git add -f` — same applies to this plan).

## Global Constraints

- No timers/cron: index updates trigger only from `tool.execute.after` → queue → `session.idle` flush, plus cold-start `health-check` + explicit `reindex --from-snapshot`.
- Every child spawn sets `windowsHide: true, shell: false, stdio: pipe`; never `detached: true`, `inherit`, or `cmd /c start`.
- All hooks fail-open: timeouts/errors return a short hint string, never throw into the host.
- Tool schemas publish no `anyOf`; every schema keeps an explicit `required` array (even if `[]`).
- `.code-graph.toml` snapshot config name is unchanged (out of scope).
- `cargo clippy` runs with `-D warnings` (per `Cargo.toml` lints); keep it green.

## Review Focus

- BUSY index (`index.db` locked by a concurrent writer) during idle flush must surface the actionable hint, not a stack trace — test: `wrap_index_busy` message path via two racing `incremental-index` runs.
- Old-dir fallback must be read-only: queries may read legacy `.code-graph/index.db`, but no write path may create or modify anything under `.code-graph/` — test: legacy fixture + write attempt leaves legacy dir mtime/content untouched.
- Snapshot trust env (`CODE_GRAPH_SNAPSHOT_TRUST_ORIGIN` / `PIN`) behavior unchanged after the dir move — test: existing `src/snapshot/tests.rs` suite stays green unmodified in logic (path literals updated only).
- Windows spawn audit: every `spawn`/`execFile*` in `opencode-plugin/` routes through `hidden()` — test: grep-style node test failing on a call site without it (mirror `windows-hide.test.js`).
- Model tool with neither `symbol_name` nor `route_path`/`node_id` must return the handler's refusal text as content, not throw — test: `get_call_graph` with `{}` via plugin returns refusal string.

---

### Task 1: Rust data-dir migration to `.codegraph/` with legacy read-compat

**Files:**
- Modify: `src/domain.rs:6`
- Modify: `src/cli/paths.rs:19-139` (`resolve_project_root_from`, `effective_read_root`)
- Modify: `src/cli/mod.rs:222-281` (`CliContext::open_inner`, `try_open`)
- Modify: `src/cli/index_ops.rs:388-449` (`cmd_incremental_index_opts` — migration call)
- Modify: `src/main.rs:183-240` (no-`.git`-anchor guard message + `CODE_GRAPH_DIR` join)
- Modify: `src/cli/health.rs:239-261` (no-index JSON path)
- Modify: `src/indexer/watcher.rs:45` (ignore list)
- Modify: `.gitignore:5` (add `.codegraph/`)
- Modify test literals: `src/utils/gitignore.rs` tests (`".code-graph/\n"` → new), `src/cli/tests.rs`, `src/indexer/watcher.rs:215-225` tests, `src/snapshot/tests.rs` path literals, `claude-plugin/scripts/*.test.js` fixtures (only if they assert on Rust output paths; otherwise untouched)
- Test: extend `src/cli/tests.rs`, `src/utils/gitignore.rs` tests

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 3–5, names pinned):
  - `pub const CODE_GRAPH_DIR: &str = ".codegraph"` (`src/domain.rs`)
  - `pub const LEGACY_CODE_GRAPH_DIR: &str = ".code-graph"` (`src/domain.rs`)
  - `pub fn index_db_path(project_root: &Path) -> PathBuf` (`src/cli/paths.rs`): returns `<root>/.codegraph/index.db` when it exists OR when no legacy DB exists; else legacy `<root>/.code-graph/index.db`. Pure read-routing, creates nothing.
  - `pub fn code_graph_dir_for_write(project_root: &Path) -> PathBuf` (`src/cli/paths.rs`): always `<root>/.codegraph`. Only write paths use it.
  - `pub fn maybe_migrate_legacy_dir(project_root: &Path) -> Result<bool>` (`src/cli/index_ops.rs`): when new DB absent and legacy `index.db` present: `ensure_owned_dir(new)`, copy `index.db` file (only the main file; drop `-wal`/`-shm` on both sides first, best-effort), return `true`; any failure → return `Ok(false)` (fail-open to full index). Never deletes or modifies the legacy dir.

- [ ] **Step 1: Write failing tests in `src/cli/tests.rs`**
  - `new_dir_constant_is_codegraph`: assert `CODE_GRAPH_DIR == ".codegraph"` and `LEGACY_CODE_GRAPH_DIR == ".code-graph"`.
  - `index_db_path_prefers_new_dir`: fixture with both dirs + `index.db` in each → `index_db_path` ends with `.codegraph/index.db`.
  - `index_db_path_falls_back_to_legacy`: only legacy `index.db` → path ends with `.code-graph/index.db`.
  - `index_db_path_defaults_to_new_when_neither`: path ends with `.codegraph/index.db` and nothing was created on disk.
  - `resolve_project_root_from_sees_new_index`: cwd without `.git` but with `.codegraph/index.db`, indexed ancestor elsewhere → resolves to cwd (mirrors existing stray-index tests at `tests.rs:1148-1151`).
  - `maybe_migrate_copies_legacy_then_incremental`: legacy `index.db` (valid, built by `build_full_index_at` into a temp legacy dir in-test) + no new dir → `maybe_migrate_legacy_dir` returns `true`, new `index.db` exists, legacy `index.db` byte-identical to before.
  - `maybe_migrate_is_false_when_nothing_legacy`: empty root → `Ok(false)`, no dir created.
- [ ] **Step 2: Run to verify they fail**
  - Run: `cargo test --lib cli::tests::new_dir_constant_is_codegraph cli::tests::index_db_path cli::tests::maybe_migrate cli::tests::resolve_project_root_from_sees_new_index`
  - Expected: FAIL (functions/constants do not exist yet).
- [ ] **Step 3: Implement constants + helpers + rewire call sites**
  - `src/domain.rs`: change `CODE_GRAPH_DIR`, add `LEGACY_CODE_GRAPH_DIR`.
  - `src/cli/paths.rs`: add `index_db_path`, `code_graph_dir_for_write`; `resolve_project_root_from` checks `CODE_GRAPH_DIR` first then legacy (both count as "indexed" for nearest-indexed logic, new wins ties); `effective_read_root` checks new own-index, then legacy own-index, then worktree-main new, then worktree-main legacy.
  - `src/cli/mod.rs` `open_inner`/`try_open`: replace `project_root.join(CODE_GRAPH_DIR).join("index.db")` existence checks with `index_db_path`; `try_open` returns `None` only when neither exists.
  - `src/cli/index_ops.rs` `cmd_incremental_index_opts`: after the `!has_git && !has_index` guard (guard checks new OR legacy), call `maybe_migrate_legacy_dir` before the `db_path.exists()` branch; `db_path` becomes `index_db_path(project_root)` post-migration.
  - `src/main.rs` guard: `has_index` true when either dir has `index.db`; message names `.codegraph/`.
  - `src/cli/health.rs` no-index JSON: `db_path` via `index_db_path`; `issue` string names the resolved path.
  - `src/indexer/watcher.rs`: ignore list becomes `[CODE_GRAPH_DIR, LEGACY_CODE_GRAPH_DIR, ".git"]` (literals, not const refactor).
  - `.gitignore`: append `.codegraph/` line under `# Runtime data`.
- [ ] **Step 4: Update literal-asserting tests, run full suite**
  - `src/utils/gitignore.rs` tests: `".code-graph/\n"` → `".codegraph/\n"`; add one case: pre-existing legacy `.code-graph/` gitignore entry does NOT trigger a second write (mirrors `an_existing_gitignore_entry_is_enough`).
  - `src/indexer/watcher.rs` tests: update `is_ignored_watch_path(".code-graph")` lines to new dir; add legacy assertion.
  - `src/snapshot/tests.rs`, `src/cli/tests.rs` remaining `".code-graph"` literals that name the data dir → new name (config-toml literals stay).
  - Run: `cargo test` Expected: PASS. Run: `cargo clippy --all-targets` Expected: no warnings.
- [ ] **Step 5: Commit**
  - Run: `git add -f src docs/superpowers/plans/2026-10-03-opencode-v2-plugin.md 2>/dev/null; git add src .gitignore; git commit -m "feat: migrate data dir to .codegraph with legacy read-compat"`
  - Expected: commit created (plan file needs `-f`: `docs/*` is gitignored).

### Task 2: Plugin scaffold — spawn infra, binary resolution, queue skeleton

**Files:**
- Create: `opencode-plugin/package.json` (name `codegraph-opencode-plugin`, no deps, `engines node >=18`)
- Create: `opencode-plugin/index.ts` (plugin entry: `Plugin.define({id: "codegraph", setup})`, wires Tasks 3–4; idle-subscribe loop with `AbortController`, cleanup returns `() => c.abort()`)
- Create: `opencode-plugin/spawn.ts`
- Create: `opencode-plugin/binary.ts`
- Create: `opencode-plugin/queue.ts`
- Create: `opencode-plugin/spawn.test.js` (node:test, mirrors `windows-hide.test.js` approach)
- Test: `opencode-plugin/queue.test.js` (node:test, no build step)

**Interfaces:**
- Consumes: Task 1 (`CODE_GRAPH_DIR` name for `resolveProjectRoot`-equivalent JS: walk up from `cwd` looking for `.codegraph/index.db`, then `.git`; stop at `$HOME`).
- Produces (used by Tasks 3–4):
  - `hidden(opts = {}): { windowsHide: true, ...opts }` (`spawn.ts`, port of `claude-plugin/scripts/proc-opts.js:38`).
  - `resolveBin(): string | null` (`binary.ts`): order `process.env.CODEGRAPH_BIN` → `PATH` (`where`/`which`, 2s timeout, via `hidden`) → `<pluginRoot>/../bin/codegraph[-platform]` → `~/.cache/code-graph/bin`; version-gate skipped (single local binary). Returns `null` (fail-open) when not found.
  - `runCodegraph(args: string[], signal?: AbortSignal): { ok: boolean, stdout: string }` (`spawn.ts`): `execFileSync(bin, [...args, "--json"], {encoding:"utf8", stdio:"pipe", shell:false, windowsHide:true, timeout:15000, signal})`; non-zero/timeout/signal → `{ok:false, stdout:""}` (caller renders hint; never throws except when `bin` is null → `{ok:false}`).
  - `noteEdit(filePath: string): void` + `takePending(): string[]` (`queue.ts`): in-memory `Set`, project-relative dedupe, cap 500 entries (drop oldest); `takePending` drains.
  - `resolveProjectRoot(cwd: string): string` (in `binary.ts` or `queue.ts` — pick one, document in file header): JS mirror of `resolve_project_root_from` for the NEW dir only + legacy fallback (no worktree-main logic; CLI owns that via `effective_read_root`).

- [ ] **Step 1: Write failing node tests**
  - `queue.test.js`: `noteEdit` dedupes same path twice; `takePending` drains and second call is empty; 501 notes keep size ≤ 500.
  - `spawn.test.js`: read every `*.ts` in `opencode-plugin/` (excluding tests), regex-assert each `spawn|execFile|spawnSync|execFileSync` call site is accompanied by `hidden(` or `windowsHide` on the same statement block; assert `hidden()` default object contains `windowsHide: true` by requiring the compiled-equivalent (test the `hidden` function via `npx tsx` if available, else duplicate the 3-line function contract: test asserts source contains `windowsHide: true`).
- [ ] **Step 2: Run to verify they fail**
  - Run: `node --test opencode-plugin/queue.test.js opencode-plugin/spawn.test.js`
  - Expected: FAIL (files do not exist).
- [ ] **Step 3: Implement `spawn.ts`, `binary.ts`, `queue.ts`, `index.ts` skeleton**
  - `index.ts` setup: `await ctx.tool.hook("execute.after", ...)` stub pushing edit/write/patch file paths to `noteEdit` (full flush logic is Task 4; skeleton only queues + logs nothing), idle-subscribe loop stub calling a `flushSoon()` no-op placeholder exported from `queue.ts` (Task 4 fills it). Keep skeleton compiling: `flushSoon` exists now, body `// Task 4`.
- [ ] **Step 4: Run tests to verify they pass**
  - Run: `node --test opencode-plugin/`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - Run: `git add opencode-plugin/ && git commit -m "feat(opencode-plugin): scaffold spawn/binary/queue infra"`
  - Expected: commit created.

### Task 3: Register all 7 model tools (schema照搬 `src/mcp/tools.rs:45-229`)

**Files:**
- Create: `opencode-plugin/tools.ts`
- Modify: `opencode-plugin/index.ts` (call `ctx.tool.transform(editor => editor.add(...))` per tool with `options: {namespace: "codegraph", codemode: false}`)
- Create: `opencode-plugin/tools.test.js`
- Test: `opencode-plugin/tools.test.js`

**Interfaces:**
- Consumes: Task 2 (`runCodegraph`, `resolveBin`).
- Produces:
  - `TOOL_CLI_MAP: Record<toolName, (input) => string[]>` — exact argv per tool (flags verified against CLI structs):
    - `semantic_code_search` → `["search", q, --json, --compact?, --language?, --node-type?, --limit N]` (`SearchArgs`: `--limit` alias `--top-k`, clamp 1–100)
    - `get_call_graph` → `["callgraph", symbol?, --node-id?, --direction?, --depth?, --file?, --min-confidence?, --include-tests?, --compact?, --json]`; `route_path` set → `["trace", route, --depth?, --no-middleware? (when include_middleware===false), --include-tests?, --min-confidence?, --json]` (`CallgraphArgs`, `TraceArgs`)
    - `get_ast_node` → `["show", symbol?, --node-id?, --file?, --refs? (include_references), --impact? (include_impact), --include-tests?, --context-lines?, --compact?, --json]` (`ShowArgs`)
    - `project_map` → `["map", --compact?, --json]` (`MapArgs`)
    - `module_overview` → `["overview", path, --compact?, --json]` (`OverviewArgs`; `include_deps`/`include_dead` have no CLI bare equivalent — pass through as hint suffix, do not invent flags)
    - `ast_search` → `["ast-search", query?, --type?, --returns?, --params?, --limit?, --json]` (`AstSearchArgs`)
    - `find_references` → `["refs", symbol?, --node-id?, --file?, --relation?, --min-confidence?, --compact?, --json]` (`RefsArgs`)
  - `executeTool(toolName, input, signal): Promise<{content: string}>`: `runCodegraph(argv, signal)`; `ok:false` → `{content: "codegraph unavailable (<reason>): <hint>"}` where reason ∈ `no-binary|timeout|locked|no-index` (detect `no_index`/`database is locked` substrings); refusal text from CLI (exit-1 usage lines) passes through as content verbatim.
  - Descriptions + `input_schema.properties` copied verbatim from `src/mcp/tools.rs` (including `required` arrays as-is, `[]` where empty).

- [ ] **Step 1: Write failing test `tools.test.js`**
  - Assert the 7 tool defs exported from `tools.ts` (import via tsx if available; else assert against a generated `tools.snapshot.json` the implementation writes — pick import-via-`npx tsx`, fallback snapshot file): names equal `LIVE_MCP_TOOLS` order; no schema contains `anyOf`; every schema has `required`; argv builder cases: `get_call_graph {symbol_name:"f"}` → contains `callgraph`; `{route_path:"GET /x"}` → starts with `trace`; `module_overview {path:"src/"}` → `["overview","src/",...]` with no `--include-deps` flag.
- [ ] **Step 2: Run to verify it fails**
  - Run: `node --test opencode-plugin/tools.test.js`
  - Expected: FAIL (`tools.ts` missing).
- [ ] **Step 3: Implement `tools.ts`, wire into `index.ts`**
  - One `editor.add` per tool, `codemode: false`, `execute: (input, toolCtx) => executeTool(name, input, toolCtx.signal)`.
- [ ] **Step 4: Run tests to verify they pass**
  - Run: `node --test opencode-plugin/`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - Run: `git add opencode-plugin/ && git commit -m "feat(opencode-plugin): register 7 model tools via ctx.tool.transform"`
  - Expected: commit created.

### Task 4: Hook wiring — after-queue, idle flush, start/context injection, before-hint

**Files:**
- Modify: `opencode-plugin/index.ts`, `opencode-plugin/queue.ts` (fill `flushSoon`)
- Create: `opencode-plugin/hooks.ts` (hint-text builders)
- Create: `opencode-plugin/hooks.test.js`
- Test: `opencode-plugin/hooks.test.js`, extend `queue.test.js` flush behavior via injected fake runner

**Interfaces:**
- Consumes: Tasks 2–3 (`noteEdit`, `takePending`, `runCodegraph`, tool map).
- Produces (behavioral, pinned):
  - `tool.execute.after`: if `event.tool ∈ {edit, write, patch}` and input has a file path → `noteEdit(path)`. Nothing else (no spawn).
  - `session.idle` (via `ctx.event.subscribe`, debounced 3s in `flushSoon`): `takePending()` non-empty + binary found → one `runCodegraph(["incremental-index","--quiet","--no-embed"], signal)` with 15s timeout; result ignored except `ok:false` caused by lock → single `tracing`-equivalent no-op (silent; next idle retries). Cold path: `health-check --json` reports `no_index` → run `reindex --from-snapshot --quiet --no-embed` once per session (guard flag), else plain `incremental-index` (which full-builds when DB absent — Task 1 migration runs inside it).
  - `session.context` (session start): append `map --compact` output capped at 4000 bytes as context; on `no_index`/binary-missing → append nothing (silent). Cap enforced by byte-length slice + `…(truncated, run map --compact)` suffix.
  - `tool.execute.before` hint-only: bash/grep-like input matching `grep|rg|grep -r` → hint `"Prefer codegraph_search/find_references tools over grep for symbol lookup."`; read/edit input with a symbol-ish path → none (no hint spam). Hints returned as context text, input never mutated.

- [ ] **Step 1: Write failing tests**
  - `hooks.test.js`: `buildGrepHint("grep -rn foo")` returns the prefer-codegraph string ≤ 200 chars; `buildGrepHint("ls -la")` returns `null`; `capBytes(s, 4000)` truncates with suffix; `flushSoon` debounce: with fake `run` injected, 3 rapid calls → 1 run; empty queue → 0 runs.
- [ ] **Step 2: Run to verify they fail**
  - Run: `node --test opencode-plugin/hooks.test.js`
  - Expected: FAIL.
- [ ] **Step 3: Implement `hooks.ts`, fill `flushSoon`, wire 4 hooks in `index.ts`**
  - `execute.before` handler returns hint text only; `execute.after` only queues; idle loop `for await (const ev of ctx.event.subscribe({signal})) if (ev.type === "session.idle") flushSoon()`; context hook appends capped map.
- [ ] **Step 4: Run tests**
  - Run: `node --test opencode-plugin/`
  - Expected: PASS.
- [ ] **Step 5: Commit**
  - Run: `git add opencode-plugin/ && git commit -m "feat(opencode-plugin): hook wiring (queue/idle/context/hint)"`
  - Expected: commit created.

### Task 5: E2E verification, packaging docs, repo hygiene

**Files:**
- Create: `opencode-plugin/README.md` (install: copy/symlink to `<project>/.opencode/plugins/codegraph/` or global `~/.config/opencode/plugins/codegraph/`; `CODEGRAPH_BIN` override; `opencode.jsonc` `plugins: ["./opencode-plugin"]` alternative)
- Create: `opencode.jsonc.example` (repo root, `{"plugins": ["./opencode-plugin"]}` minimal)
- Modify: `README.md` (short section linking `opencode-plugin/README.md`; do not rewrite MCP docs)
- Test: manual checklist (below) + `cargo test` + `node --test opencode-plugin/` green

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: installable plugin dir + docs. No new code interfaces.

- [ ] **Step 1: Build release binary, run manual E2E**
  - Run: `cargo build --release` then in a scratch git repo: `<bin> incremental-index --json` → `mode: full`; edit a file → `<bin> incremental-index --quiet --no-embed --json` → `mode: incremental`; `<bin> health-check --json` → `healthy: true`; each query subcommand with `--json` → parseable stdout; legacy fixture: only `.code-graph/index.db` → `incremental-index` migrates to `.codegraph/` and legacy bytes unchanged.
  - Expected: all commands exit 0, JSON parses, no console window observed (Windows), `git status` shows no `.codegraph/` tracked (excluded via `info/exclude`).
- [ ] **Step 2: Plugin smoke (requires opencode CLI installed; else record as skipped)**
  - Copy `opencode-plugin/` to scratch repo `.opencode/plugins/codegraph/`, open opencode, run a `codegraph_search`-equivalent tool call; edit a file, wait for idle, confirm `.codegraph/index.db` mtime advanced.
  - Expected: tool returns content; DB mtime advances; no popup. If opencode unavailable, note `SKIPPED(opencode-cli-missing)` in the commit message body.
- [ ] **Step 3: Full automated suites green**
  - Run: `cargo test` + `cargo clippy --all-targets` + `node --test opencode-plugin/`
  - Expected: all PASS, no warnings.
- [ ] **Step 4: Commit docs + example**
  - Run: `git add -f opencode-plugin/README.md opencode.jsonc.example; git add README.md; git commit -m "docs: opencode v2 plugin install + verification"`
  - Expected: commit created.

## Self-Review

1. **Spec coverage:** §2 architecture → Tasks 2–4; §3 storage/paths/migration → Task 1; §4 trigger matrix → Task 4 (all four rows); §5 seven tools → Task 3; §6 snapshot (unchanged code, works via `CODE_GRAPH_DIR` const) → covered by Task 1 + Task 5 E2E (`reindex --from-snapshot` manual run — added to Step 1); §7 no-popup → Tasks 2 (`hidden`), 4 (pipe/timeout), 5 (observe); §8 fail-open/cap → Tasks 2–4. Gap found: E2E Step 1 lacked snapshot check — fix by adding `reindex --from-snapshot --json` fallback-to-full run on a repo with no snapshot source (expects `mode: full|incremental`, exit 0).
2. **Step scan:** each test step names assertions, each code step names signatures/files; `flushSoon` debounce test uses injected fake runner (no real timers in test). Bodies appear only for algorithms tests don't determine (argv map table — pinned values, acceptable).
3. **Type consistency:** `runCodegraph` returns `{ok, stdout}` object in Task 2; Task 3 `executeTool` consumes it — consistent. `noteEdit/takePending` names match across Tasks 2/4. Rust `index_db_path`/`code_graph_dir_for_write`/`maybe_migrate_legacy_dir` signatures used consistently in Task 1 steps.
4. **Review Focus:** all five lines have owning tests (BUSY → Task 1 `wrap_index_busy` race note + Task 4 silent-retry; legacy read-only → Task 1 mtime test — strengthen: assert legacy `index.db` mtime unchanged after `incremental-index`; snapshot env → existing suite green; spawn audit → Task 2 test; refusal-as-content → Task 3 `get_call_graph {}` case — add it: argv `["callgraph","--json"]` with no symbol → CLI exits 1 with usage → content contains "Usage").
5. **Proportion:** plan is longer than the spec but the spec is a 9-section brief while the plan pins 7 tool arg maps + hook behaviors executors cannot derive — justified; no function bodies transcribed.
