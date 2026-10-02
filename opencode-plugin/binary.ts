/**
 * binary.ts — CLI binary resolution + project-root resolution.
 *
 * `resolveBin()`: `CODEGRAPH_BIN` env → PATH (`where` on win32 / `which`
 * otherwise, 2s timeout) → `<pluginRoot>/../bin/codegraph…` →
 * `~/.cache/code-graph/bin`. Version-gate skipped. Fail-open: `null` when
 * nothing usable is found. PATH probe inlines the no-popup literals (see
 * note below) to keep the import one-directional (spawn.ts → binary.ts).
 *
 * `resolveProjectRoot(cwd)`: walk up from `cwd` looking for
 * `.codegraph/index.db`, then the legacy fallback `.code-graph/index.db`,
 * then `.git`; stop at `$HOME` (exclusive — never treat `$HOME` itself as
 * root). Mirrors `src/cli/paths.rs resolve_project_root_from` for the NEW dir
 * + legacy fallback; NO worktree-main logic (the CLI owns that via
 * `effective_read_root`).
 *
 * No-popup rule: every child spawn in this file routes through `hidden()`
 * (`spawn.ts` — single choke point, port of `claude-plugin/scripts/proc-opts.js:38`):
 * `windowsHide: true, shell: false, stdio: pipe`; never `detached: true`,
 * `inherit`, or `cmd /c start`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hidden } from "./spawn.ts";

export const CODE_GRAPH_DIR = ".codegraph";
export const LEGACY_CODE_GRAPH_DIR = ".code-graph";

function isFile(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

function hasIndex(d: string): boolean {
  return (
    isFile(join(d, CODE_GRAPH_DIR, "index.db")) ||
    isFile(join(d, LEGACY_CODE_GRAPH_DIR, "index.db"))
  );
}

// Probe PATH for the binary without ever flashing a console window.
function findOnPath(): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(probe, ["codegraph"], {
      encoding: "utf8",
      ...hidden({ stdio: "pipe", shell: false, timeout: 2000 }),
    });
    const first = String(out).split(/\r?\n/, 1)[0]?.trim();
    return first && isFile(first) ? first : null;
  } catch {
    return null;
  }
}

// Fail-open binary resolution. Never throws.
export function resolveBin(): string | null {
  const fromEnv = process.env.CODEGRAPH_BIN?.trim();
  if (fromEnv && isFile(fromEnv)) return fromEnv;

  const onPath = findOnPath();
  if (onPath) return onPath;

  const exe = process.platform === "win32" ? ".exe" : "";
  const here = dirname(fileURLToPath(import.meta.url));
  for (const name of [`codegraph${exe}`, `codegraph-mcp${exe}`, `code-graph-mcp${exe}`]) {
    const bundled = join(here, "..", "bin", name);
    if (isFile(bundled)) return bundled;
  }

  const cacheDir = join(homedir(), ".cache", "code-graph", "bin");
  for (const name of [`codegraph${exe}`, `codegraph-mcp${exe}`, `code-graph-mcp${exe}`]) {
    const cached = join(cacheDir, name);
    if (isFile(cached)) return cached;
  }

  return null;
}

// Canonical project root for `cwd` — mirror of Rust
// `resolve_project_root_bounded` (minus worktree-main logic):
// 1. cwd's own `.git` → cwd (a real project boundary).
// 2. cwd's index wins unless STRAY (an indexed ancestor within the bound).
// 3. Else nearest indexed ancestor, else nearest `.git` root, else ""
// (fail-open: nothing to read — the JS reader has no index to create,
// unlike the Rust writer which falls back to cwd).
// `$HOME` itself is never adopted as root from below. `start === $HOME` keeps
// only its own index (a deliberately indexed home dir keeps working).
export function resolveProjectRoot(cwd: string): string {
  const home = resolve(homedir());
  const start = resolve(cwd || ".");

  if (start === home) return hasIndex(start) ? start : "";

  // 1. cwd's own `.git` is always a boundary (mirrors Rust rule 1, which
  //    returns cwd even without an index because the CLI CREATES one there).
  if (existsSync(join(start, ".git"))) return start;
  const cwdHasIndex = hasIndex(start);

  // Walk STRICT ancestors, stopping AT `$HOME` (exclusive) or the nearest
  // `.git` root. Both the new dir and the legacy dir count as "indexed".
  let nearestIndexed: string | null = null;
  let gitRootIndexed: string | null = null;
  let nearestGit: string | null = null;
  let cursor: string | null = dirname(start);
  while (cursor) {
    if (cursor === home) break;
    const indexed = hasIndex(cursor);
    if (nearestIndexed === null && indexed) nearestIndexed = cursor;
    if (existsSync(join(cursor, ".git"))) {
      nearestGit = cursor;
      if (indexed) gitRootIndexed = cursor;
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // 2. cwd's index wins only when it is NOT stray.
  if (cwdHasIndex && nearestIndexed === null) return start;
  // 3. Prefer the indexed `.git` root over a nearer STRAY indexed ancestor.
  if (gitRootIndexed !== null) return gitRootIndexed;
  if (nearestIndexed !== null) return nearestIndexed;
  if (nearestGit !== null) return nearestGit;
  return "";
}
