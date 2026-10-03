const { test } = require("node:test");
const assert = require("node:assert");
const { buildGrepHint, buildSessionContext, capBytes } = require("./hooks.ts");

test("buildGrepHint: grep-like command returns prefer-codegraph string <=200 chars", () => {
  const h = buildGrepHint("grep -rn foo");
  assert.ok(typeof h === "string" && h.length > 0);
  assert.ok(h.length <= 200, `hint too long: ${h.length}`);
  assert.match(h, /codegraph/i);
});

test("buildGrepHint: rg command also hints", () => {
  const h = buildGrepHint("rg 'some symbol' src/");
  assert.ok(typeof h === "string" && h.length <= 200);
});

test("buildGrepHint: non-search command returns null", () => {
  assert.strictEqual(buildGrepHint("ls -la"), null);
});

test("buildGrepHint: read/edit-shaped input returns null (no hint spam)", () => {
  assert.strictEqual(buildGrepHint("read src/foo.ts"), null);
  assert.strictEqual(buildGrepHint("edit src/foo.ts"), null);
});

test("capBytes: short input untouched", () => {
  assert.strictEqual(capBytes("hello", 4000), "hello");
});

test("capBytes: long input truncated with suffix", () => {
  const s = "x".repeat(5000);
  const out = capBytes(s, 4000);
  assert.ok(Buffer.byteLength(out, "utf8") <= 4000 + 100, `too long: ${Buffer.byteLength(out, "utf8")}`);
  assert.match(out, /truncated/);
});

test("buildSessionContext: ok:true with no_index stdout -> silent empty", () => {
  const out = buildSessionContext(() => ({
    ok: true,
    stdout: '{"healthy":false,"reason":"no_index"}',
  }));
  assert.strictEqual(out, "");
});

test("flushSoon: 3 rapid calls -> 1 run (debounce)", async (t) => {
  const { flushSoon, noteEdit, takePending, __testReset } = require("./queue.ts");
  __testReset();
  takePending();
  let runs = [];
  const runner = (args) => {
    runs.push(args);
    return { ok: true, stdout: "{}" };
  };
  noteEdit("a.ts");
  flushSoon(runner);
  flushSoon(runner);
  flushSoon(runner);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(runs.length, 1);
  __testReset();
});

test("flushSoon: empty queue -> 0 runs", async () => {
  const { flushSoon, takePending, __testReset } = require("./queue.ts");
  __testReset();
  takePending();
  let runs = 0;
  flushSoon(() => {
    runs++;
    return { ok: true, stdout: "{}" };
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(runs, 0);
  __testReset();
});
