const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TOOL_DEFINITIONS, TOOL_CLI_MAP, executeTool } = require("./tools.ts");

const LIVE_MCP_TOOLS = [
  "semantic_code_search",
  "get_call_graph",
  "get_ast_node",
  "project_map",
  "module_overview",
  "ast_search",
  "find_references",
];

test("7 tool defs exported in LIVE_MCP_TOOLS order", () => {
  assert.deepStrictEqual(TOOL_DEFINITIONS.map((t) => t.name), LIVE_MCP_TOOLS);
});

test("no schema contains anyOf; every schema has a required array", () => {
  for (const def of TOOL_DEFINITIONS) {
    const raw = JSON.stringify(def.input_schema);
    assert.ok(!raw.includes("anyOf"), `${def.name}: schema publishes anyOf`);
    assert.ok(Array.isArray(def.input_schema.required), `${def.name}: no required array`);
  }
});

test("required arrays as-is from tools.rs", () => {
  const req = Object.fromEntries(TOOL_DEFINITIONS.map((t) => [t.name, t.input_schema.required]));
  assert.deepStrictEqual(req.semantic_code_search, ["query"]);
  assert.deepStrictEqual(req.module_overview, ["path"]);
  for (const n of ["get_call_graph", "get_ast_node", "project_map", "ast_search", "find_references"]) {
    assert.deepStrictEqual(req[n], [], n);
  }
});

test("Ruling 2: semantic_code_search description carries FTS-only suffix", () => {
  const def = TOOL_DEFINITIONS.find((t) => t.name === "semantic_code_search");
  assert.match(def.description, / \(plugin CLI: FTS-only\)$/);
});

test("argv: get_call_graph {symbol_name} -> callgraph", () => {
  const argv = TOOL_CLI_MAP.get_call_graph({ symbol_name: "f" });
  assert.ok(argv.includes("callgraph"));
  assert.ok(argv.includes("f"));
});

test("argv: get_call_graph {route_path} -> starts with trace", () => {
  const argv = TOOL_CLI_MAP.get_call_graph({ route_path: "GET /x" });
  assert.strictEqual(argv[0], "trace");
  assert.ok(argv.includes("GET /x"));
});

test("argv: module_overview {path} -> overview, no --include-deps flag", () => {
  const argv = TOOL_CLI_MAP.module_overview({ path: "src/" });
  assert.deepStrictEqual(argv.slice(0, 2), ["overview", "src/"]);
  assert.ok(!argv.some((a) => a.startsWith("--include-deps") || a.startsWith("--include-dead")), argv.join(" "));
});

test("argv: get_call_graph {} -> callgraph, no symbol (refusal-as-content path)", () => {
  assert.deepStrictEqual(TOOL_CLI_MAP.get_call_graph({}), ["callgraph"]);
});

test("argv: search clamps limit 1-100 and maps node_type", () => {
  const argv = TOOL_CLI_MAP.semantic_code_search({ query: "q", top_k: 500, node_type: "fn" });
  assert.ok(argv.includes("--limit") && argv.includes("100"), argv.join(" "));
  assert.ok(argv.includes("--node-type") && argv.includes("fn"));
});

test("argv: show maps include_references/include_impact to --refs/--impact", () => {
  const argv = TOOL_CLI_MAP.get_ast_node({ symbol_name: "f", include_references: true, include_impact: true });
  assert.ok(argv.includes("--refs") && argv.includes("--impact"), argv.join(" "));
});

test("argv: trace mode --no-middleware only when include_middleware===false", () => {
  const on = TOOL_CLI_MAP.get_call_graph({ route_path: "GET /x" });
  assert.ok(!on.includes("--no-middleware"), on.join(" "));
  const off = TOOL_CLI_MAP.get_call_graph({ route_path: "GET /x", include_middleware: false });
  assert.ok(off.includes("--no-middleware"), off.join(" "));
});

test("runCodegraph(): script-file argv survives the appended --json (exactly one)", async () => {
  const prev = process.env.CODEGRAPH_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-fakebin-"));
  const fake = path.join(dir, "codegraph.exe");
  fs.copyFileSync(process.execPath, fake);
  const script = path.join(dir, "echo-argv.js");
  fs.writeFileSync(script, "console.log(process.argv.slice(1).join(' '));");
  process.env.CODEGRAPH_BIN = fake;
  try {
    const { runCodegraph } = require("./spawn.ts");
    const r = runCodegraph([script]);
    assert.strictEqual(r.ok, true);
    assert.match(r.stdout, /--json/);
    assert.strictEqual((r.stdout.match(/--json/g) || []).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prev;
  }
});

test("executeTool(): module_overview hint path (patched argv probe)", async () => {
  const prev = process.env.CODEGRAPH_BIN;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-fakebin-"));
  const fake = path.join(dir, "codegraph.exe");
  fs.copyFileSync(process.execPath, fake);
  const script = path.join(dir, "ok.js");
  fs.writeFileSync(script, "console.log('{\"ok\":true}');");
  // Route executeTool through the fake: temporarily map overview argv to the
  // probe script by calling executeTool with a monkey-patched TOOL_CLI_MAP.
  const orig = TOOL_CLI_MAP.module_overview;
  TOOL_CLI_MAP.module_overview = () => [script];
  process.env.CODEGRAPH_BIN = fake;
  try {
    const r = await executeTool("module_overview", { path: "src/", include_dead: true });
    assert.match(r.content, /"ok":true/);
    assert.match(r.content, /include_dead/);
  } finally {
    TOOL_CLI_MAP.module_overview = orig;
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prev;
  }
});

test("executeTool(): missing binary fail-opens, never throws", async () => {
  const prevBin = process.env.CODEGRAPH_BIN;
  const prevPath = process.env.PATH;
  process.env.CODEGRAPH_BIN = path.join(os.tmpdir(), "codegraph-missing-bin-xyz");
  process.env.PATH = os.tmpdir();
  try {
    const r = await executeTool("project_map", {});
    assert.match(r.content, /codegraph unavailable/);
  } finally {
    if (prevBin === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prevBin;
    process.env.PATH = prevPath;
  }
});

test("executeTool(): unknown tool never throws", async () => {
  const r = await executeTool("nope_not_a_tool", {});
  assert.match(r.content, /codegraph unavailable/);
});
