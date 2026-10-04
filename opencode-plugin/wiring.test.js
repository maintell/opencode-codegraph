const { test } = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const plugin = require("./index.ts");

const EXPECTED = [
  "semantic_code_search",
  "get_call_graph",
  "get_ast_node",
  "project_map",
  "module_overview",
  "ast_search",
  "find_references",
];

async function captureAdds() {
  let transformCb = null;
  const fakeCtx = {
    tool: {
      hook: async () => {},
      transform: async (cb) => {
        transformCb = cb;
      },
    },
    session: { hook: async () => {} },
    event: {
      subscribe: async function* () {},
    },
  };
  await plugin.default.setup(fakeCtx);
  assert.ok(transformCb, "transform callback not captured");
  const calls = [];
  const editor = {
    add: (...args) => {
      calls.push(args);
      return editor;
    },
  };
  transformCb(editor);
  return calls;
}

test("editor.add: one call per tool, exactly 1 argument, single-object shape", async () => {
  const calls = await captureAdds();
  assert.strictEqual(calls.length, 7, `expected 7 add calls, got ${calls.length}`);
  assert.deepStrictEqual(
    calls.map(([arg]) => arg.name),
    EXPECTED,
  );
  for (const args of calls) {
    assert.strictEqual(args.length, 1, `add called with ${args.length} args, expected 1`);
    const [arg] = args;
    assert.strictEqual(typeof arg.name, "string");
    assert.strictEqual(typeof arg.description, "string");
    assert.ok(arg.input && typeof arg.input === "object", `${arg.name}: missing input object`);
    assert.ok(!("input_schema" in arg), `${arg.name}: input_schema key must be absent (map to input:)`);
    assert.strictEqual(arg.options?.namespace, "codegraph", `${arg.name}: options.namespace`);
    assert.strictEqual(arg.options?.codemode, false, `${arg.name}: options.codemode`);
    assert.strictEqual(typeof arg.execute, "function", `${arg.name}: execute not a function`);
  }
});

test("execute: callable, returns {content: string} (missing binary fail-open)", async () => {
  const calls = await captureAdds();
  const prevBin = process.env.CODEGRAPH_BIN;
  const prevPath = process.env.PATH;
  process.env.CODEGRAPH_BIN = path.join(os.tmpdir(), "codegraph-missing-bin-xyz");
  process.env.PATH = os.tmpdir();
  try {
    const r = await calls[0][0].execute({}, {});
    assert.strictEqual(typeof r.content, "string");
    assert.match(r.content, /codegraph unavailable/);
  } finally {
    if (prevBin === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prevBin;
    process.env.PATH = prevPath;
  }
});
