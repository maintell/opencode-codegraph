const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { hidden, runCodegraph } = require("./spawn.ts");
const { resolveBin, resolveProjectRoot } = require("./binary.ts");

const CALL = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(/;

test("every spawn/execFile call site routes through hidden()/windowsHide", () => {
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length > 0, "no .ts source files found");
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    if (CALL.test(src)) {
      assert.ok(src.includes("hidden(") || src.includes("windowsHide"), `${f}: child_process call without hidden()/windowsHide`);
    }
  }
});

test("hidden() source contains windowsHide: true", () => {
  const src = fs.readFileSync(path.join(__dirname, "spawn.ts"), "utf8");
  assert.match(src, /windowsHide:\s*true/);
});

test("hidden(): defaults windowsHide, caller opts win", () => {
  assert.deepStrictEqual(hidden(), { windowsHide: true });
  assert.deepStrictEqual(hidden({ timeout: 1 }), { windowsHide: true, timeout: 1 });
});

test("resolveBin(): CODEGRAPH_BIN env wins when it exists", () => {
  const prev = process.env.CODEGRAPH_BIN;
  process.env.CODEGRAPH_BIN = process.execPath;
  try {
    assert.strictEqual(resolveBin(), process.execPath);
  } finally {
    if (prev === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prev;
  }
});

test("resolveBin(): fail-open null when nothing usable exists", () => {
  const prevBin = process.env.CODEGRAPH_BIN;
  const prevPath = process.env.PATH;
  process.env.CODEGRAPH_BIN = path.join(os.tmpdir(), "codegraph-missing-bin-xyz");
  process.env.PATH = os.tmpdir(); // no `where`/`which` hit for codegraph here
  try {
    assert.strictEqual(resolveBin(), null);
  } finally {
    if (prevBin === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prevBin;
    process.env.PATH = prevPath;
  }
});

test("runCodegraph(): success path returns {ok:true} and appends --json", () => {
  // Fake "binary" = node running a script file: trailing argv lands in the
  // script (proving runCodegraph appends --json) instead of breaking node
  // option parsing the way `node -e … --json` would.
  const prev = process.env.CODEGRAPH_BIN;
  process.env.CODEGRAPH_BIN = process.execPath;
  const script = path.join(os.tmpdir(), `cg-fakebin-${process.pid}.js`);
  fs.writeFileSync(script, "console.log(process.argv[process.argv.length-1]);");
  try {
    const r = runCodegraph([script]);
    assert.strictEqual(r.ok, true);
    assert.match(r.stdout, /--json/);
  } finally {
    fs.rmSync(script, { force: true });
    if (prev === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prev;
  }
});

test("runCodegraph(): non-zero exit fail-opens to {ok:false}, never throws", () => {
  const prev = process.env.CODEGRAPH_BIN;
  process.env.CODEGRAPH_BIN = process.execPath;
  try {
    const r = runCodegraph(["-e", "process.exit(3)"]);
    assert.deepStrictEqual(r, { ok: false, stdout: "" });
  } finally {
    if (prev === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prev;
  }
});

test("runCodegraph(): missing binary fail-opens, never throws", () => {
  const prevBin = process.env.CODEGRAPH_BIN;
  const prevPath = process.env.PATH;
  process.env.CODEGRAPH_BIN = path.join(os.tmpdir(), "codegraph-missing-bin-xyz");
  process.env.PATH = os.tmpdir();
  try {
    assert.deepStrictEqual(runCodegraph(["search"]), { ok: false, stdout: "" });
  } finally {
    if (prevBin === undefined) delete process.env.CODEGRAPH_BIN;
    else process.env.CODEGRAPH_BIN = prevBin;
    process.env.PATH = prevPath;
  }
});

function mkTree(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cg-root-"));
  for (const f of files) {
    const p = path.join(base, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (f.endsWith(".git/")) fs.mkdirSync(p, { recursive: true });
    else fs.writeFileSync(p, "x");
  }
  return base;
}

test("resolveProjectRoot(): new dir wins, legacy fallback, git root, empty", () => {
  const base = mkTree([
    "proj/.codegraph/index.db",
    "proj/sub/deep/",
    "legacy/.code-graph/index.db",
    "gitonly/.git/",
    "empty/a/b/",
  ]);
  try {
    assert.strictEqual(resolveProjectRoot(path.join(base, "proj", "sub", "deep")), path.join(base, "proj"));
    assert.strictEqual(resolveProjectRoot(path.join(base, "legacy")), path.join(base, "legacy"));
    assert.strictEqual(resolveProjectRoot(path.join(base, "gitonly")), path.join(base, "gitonly"));
    assert.strictEqual(resolveProjectRoot(path.join(base, "empty", "a", "b")), "");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("resolveProjectRoot(): cwd index wins unless stray; indexed git root beats stray", () => {
  const base = mkTree(["repo/.git/", "repo/pkg/.codegraph/index.db"]);
  try {
    // pkg's own index, no indexed ancestor -> pkg itself (non-stray)
    // (no .git at pkg; nearest .git root repo is unindexed -> pkg wins)
    assert.strictEqual(resolveProjectRoot(path.join(base, "repo", "pkg")), path.join(base, "repo", "pkg"));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  const base2 = mkTree([
    "mono/.git/",
    "mono/.codegraph/index.db",
    "mono/sub/.codegraph/index.db",
  ]);
  try {
    // sub's index is a stray relic under indexed git root mono -> mono wins
    assert.strictEqual(
      resolveProjectRoot(path.join(base2, "mono", "sub")),
      path.join(base2, "mono"),
    );
  } finally {
    fs.rmSync(base2, { recursive: true, force: true });
  }
});
