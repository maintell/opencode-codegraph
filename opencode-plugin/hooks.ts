/**
 * hooks.ts — hint-text builders + byte cap for Task 4 hook wiring.
 *
 * `buildGrepHint()`: bash/grep-like input → one prefer-codegraph hint
 * (<=200 chars); everything else → null (no hint spam). `capBytes()`:
 * byte-length truncation with a `…(truncated, run map --compact)` suffix.
 * `buildSessionContext()`: cold-start `map --compact` injection, silent
 * (empty) on `no_index`/binary-missing. All fail-open: never throws.
 */

export const GREP_HINT =
  "Prefer codegraph_search/find_references tools over grep for symbol lookup.";

// Order matters: read/edit-shaped input returns null BEFORE the grep check,
// so a symbol-ish path never triggers hint spam.
export function buildGrepHint(input: unknown): string | null {
  try {
    if (typeof input !== "string" || input.length === 0) return null;
    const t = input.trim();
    if (t.length === 0) return null;
    // read/edit-shaped input → none (no hint spam).
    if (/^(read|edit)\s+\S+/i.test(t)) return null;
    // bash/grep-like input matching `grep|rg` command.
    if (/(^|[\s;&|])(grep|rg)\b/i.test(t)) return GREP_HINT;
    return null;
  } catch {
    return null;
  }
}

// Tool-name gate for the `execute.before` hook (mirrors the after-hook's
// `output?.tool` read): a NAMED non-bash tool never hints, so a codegraph
// tool input that merely mentions "grep" cannot over-hint. The documented
// before-event carries no tool name — when the field is absent, only a
// `command` string field proves bash shape (a bare `input` string / raw
// string alone could be any tool's, so those are gated out). Returns the
// command text to hint on, or null when gated out. Input NEVER mutated.
export function beforeHookText(ev: unknown): string | null {
  try {
    if (typeof ev !== "object" || ev === null) return null;
    const rec = ev as Record<string, unknown>;
    if (typeof rec.tool === "string" && rec.tool !== "bash") return null;
    const named = typeof rec.tool === "string";
    const body = rec.input ?? ev;
    if (typeof body === "string") return named ? body : null;
    if (typeof body !== "object" || body === null) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.command === "string") return b.command;
    if (named && typeof b.input === "string") return b.input;
    return null;
  } catch {
    return null;
  }
}

const TRUNC_SUFFIX = "…(truncated, run map --compact)";

export function capBytes(s: string, n: number): string {
  try {
    if (typeof s !== "string") return "";
    const buf = Buffer.from(s, "utf8");
    if (buf.length <= n) return s;
    const cut = Math.max(0, n - Buffer.byteLength(TRUNC_SUFFIX, "utf8"));
    // Walk back to a UTF-8 lead byte so the slice stays valid.
    let end = cut;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
    return buf.subarray(0, end).toString("utf8") + TRUNC_SUFFIX;
  } catch {
    return "";
  }
}

// Cold-start context injection runner contract (same `{ok, stdout}` shape
// as `runCodegraph`; default caller passes the real one).
export type CtxRunner = (args: string[]) => { ok: boolean; stdout: string };

// Session-start context: `map --compact` output capped at 4000 bytes;
// on `no_index`/binary-missing (ok:false) → empty (silent).
export function buildSessionContext(run: CtxRunner): string {
  try {
    const r = run(["map", "--compact"]);
    if (!r || !r.ok || !r.stdout) return "";
    if (/no_index/i.test(r.stdout)) return "";
    return capBytes(r.stdout, 4000);
  } catch {
    return "";
  }
}
