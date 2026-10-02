const { test } = require("node:test");
const assert = require("node:assert");
const { noteEdit, takePending } = require("./queue.ts");

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
