# opencode v2 插件改造设计（方案A：瘦插件 + 短命 CLI）

- Date: 2026-10-02
- Status: approved（用户确认：旧库拷贝迁移可接受；before-hook 只做 hint，无 Claude 改写）
- Paths: `src/domain.rs:6`, `src/cli/paths.rs:19-139`, `src/cli/index_ops.rs:388-449`, `src/cli/commands/reindex.rs`, `src/snapshot/install.rs`, `src/mcp/tools.rs`, `src/main.rs:183-240`

## 1. 背景与目标

当前 MCP stdio 常驻进程效率低。改造成 opencode v2 同进程插件：

1. opencode v2 插件，无常驻外部进程（短命 CLI 可接受，用户选 A）。
2. 每个项目 `<root>/.codegraph/` 存 DB。
3. 更新/查询走 opencode v2 hook 触发，无定时任务。
4. 无 git/其他窗口弹出。
5. 保留快照同步（snapshot 冷安装 + incremental 追平）。

约束：Rust 索引核心不动，只换触发/传输层；旧 `.code-graph/` 只读兼容，写侧新目录；before-hook 只 hint 不改写 input。

## 2. 架构

```text
opencode (Bun, 同进程)
└─ .opencode/plugins/codegraph/index.ts ── setup(ctx)
    ├─ tool.execute.after (edit/write/patch) → 内存队列（去重）
    ├─ event.subscribe session.idle → debounce flush → 短命 CLI
    ├─ session.context → health-check + map --compact 注入
    ├─ tool.execute.before (bash/grep/read/edit) → hint only
    └─ 7 model tools (ctx.tool.transform, codemode:false)
            └─ execFileSync(codegraph[.exe], <sub> --json, {windowsHide,shell:false,pipe,timeout,signal})

Rust 二进制（短命，查完即退）
├─ incremental-index [--quiet --no-embed --json] 增量/冷启动 full
├─ search/callgraph/show/refs/map/overview/ast-search --json 查询
├─ health-check --json 状态门
└─ reindex --from-snapshot 快照消费
```

无 MCP daemon，无 watcher，无 cron。外部编辑不做 fs.watch v1，查询时 `refresh_files_if_stale` 兜底。

## 3. 存储与路径

- `CODE_GRAPH_DIR`: `.code-graph` → `.codegraph`（`src/domain.rs:6`）。
- `resolve_project_root_from` / `effective_read_root`（`src/cli/paths.rs`）：先查新目录，缺失回退旧目录只读；写侧一律新目录。
- 首次写若旧库存在：文件拷贝 `index.db`（+清 -wal/-shm）到新目录后 incremental；拷贝失败 fail-open 走 full。
- `ensure_code_graph_dir_ignored` / `is_non_project_cwd` / `PROJECT_MARKERS` 同步改名；`.gitignore`  upkeep 保留。
- `ctx.storage` 仅 KB 级游标（`lastIndexed:<projectId>`），图数据不进 storage。

## 4. 触发矩阵

| 触发 | 动作 | CLI |
|---|---|---|
| execute.after edit/write/patch | 入队去重，不 spawn | — |
| session.idle | debounce 2–5s，一次 `incremental-index --quiet --no-embed --json`，timeout 15s，fail-open | incremental-index（无DB→full，`mode` 区分） |
| session start/context | `health-check --json`；缺库快照/迁移；`map --compact` 注入 cap 4KB | health-check, map |
| execute.before | hint only（移植 pre-*-guide 精简提示，不改 input） | 只读查询可选 |
| model tools ×7 | `execFileSync --json`，异常转 content 不抛栈 | 见 §5 |

## 5. Tool 注册（全量7，schema 照搬 `src/mcp/tools.rs`）

`semantic_code_search`, `get_call_graph`, `get_ast_node`, `project_map`, `module_overview`, `ast_search`, `find_references`。
`required:[]` 保持；管理类不暴露。`execute` 接 `toolCtx.signal`。

## 6. 快照同步（原样保留）

复用 `resolve_snapshot_source + try_install + verify + decompress(100MB cap) + meta`。触发仅：冷启动无DB、显式 `reindex --from-snapshot`。`rename last-wins`、partial 唯一名、`lock_index_for_replace` 不变。不新增 merge/pull/fetch。

## 7. 无弹窗

全 spawn 包 `hidden()`：`windowsHide:true + shell:false + stdio pipe`；禁 `detached:true`/`inherit`/`cmd /c start`。git 只读探测；下载走 Rust https client。

## 8. 错误与验证

全 hook fail-open；输出 cap 4KB；`--json` 空结果契约保留。验证：新目录解析/旧回退/迁移单测 + 手动（开项目建库、改文件 idle 增量、7 tool 可调、无闪窗、快照链）。

## 9. 不做（ponytail）

- fs.watch 外部编辑实时监听（查询时 freshness 兜底；量大换 SQLite 队列表时再加）。
- 全 TS in-process / Rust cdylib FFI（工作量/复杂度超线；短命 CLI 已满足无常驻）。
- before-hook 改写 grep input（模型 tool-list 缓存风险；hint 已够）。
- embedding GPU/批量向量优化（保持 `--no-embed` 结构优先策略）。
