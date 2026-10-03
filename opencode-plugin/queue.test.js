const { test } = require("node:test");
const assert = require("node:assert");
const { noteEdit, takePending, flushNow } = require("./queue.ts");

test("noteEdit dedupes same path twice", () => {
  takePending();
  noteEdit("a.ts");
  noteEdit("a.ts");
  assert.deepStrictEqual(takePending(), ["a.ts"]);
});

test("takePending drains and second call is empty", () => {
  takePending();
  noteEdit("x.ts");
  noteEdit("y.ts");
  const first = takePending();
  assert.deepStrictEqual(first.sort(), ["x.ts", "y.ts"]);
  assert.deepStrictEqual(takePending(), []);
});

test("501 notes keep size <= 500", () => {
  takePending();
  for (let i = 0; i < 501; i++) noteEdit(`f${i}.ts`);
  const got = takePending();
  assert.ok(got.length <= 500, `expected <=500, got ${got.length}`);
});

test("flushNow: ok:false re-queues files for next idle (no loss)", () => {
  takePending();
  noteEdit("keep1.ts");
  noteEdit("keep2.ts");
  let runs = 0;
  flushNow(() => {
    runs++;
    return { ok: false, stdout: "database is locked" };
  });
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(takePending().sort(), ["keep1.ts", "keep2.ts"]);
});

test("flushNow: runner throw re-queues files for next idle", () => {
  takePending();
  noteEdit("t.ts");
  flushNow(() => {
    throw new Error("boom");
  });
  assert.deepStrictEqual(takePending(), ["t.ts"]);
});

test("flushNow: ok:true drains for good; empty queue runs 0", () => {
  takePending();
  noteEdit("done.ts");
  let runs = 0;
  flushNow(() => {
    runs++;
    return { ok: true, stdout: "{}" };
  });
  assert.strictEqual(runs, 1);
  assert.deepStrictEqual(takePending(), []);
  flushNow(() => {
    runs++;
    return { ok: true, stdout: "{}" };
  });
  assert.strictEqual(runs, 1);
});
