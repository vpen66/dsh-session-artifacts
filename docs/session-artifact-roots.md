# 设计：会话产物根（Session artifact roots）

状态：已实现（第 15 节的三个步骤）。本文描述的行为即当前代码的行为。
实现：`src/roots.ts`（根发现与准入）、`src/inventory.ts`（严格归因与展示前缀）、`src/index.ts`（根集合、子会话聚合、`session_artifacts_report` 与 `session_artifacts_watch`）、`client/client.js`（工作区/工作区外拆分与按根分组）。
决策记录：子会话（subagent）产生的产物**算**本次会话，聚合到根会话报告。

## 1. 要解决的问题

现状：插件的扫描根是 `session.header.cwd`（[src/index.ts](../src/index.ts#L601)），baseline 与增量扫描都只从这一棵树往下走。于是"这个会话产生过的东西"只在恰好落在工作区里时才看得见。

一个真实场景：会话在 `/tmp/memcmp` 里做了几组对照实验，留下 500 MB，而报告只显示工作区里的 `target/` 234 MB 和几个被重写的 `.rs` 文件。这不是计数错误，是定义域错误。

要求：**只要是这个会话产生过的，就统计进来**，不限于工作区，也不限于 `/tmp`。

## 2. 为什么不能靠"再猜几个目录"

给 `/tmp` 加特判没有意义：产物可能在 `~/scratch`、`/var/tmp`、`/Volumes/work`、另一个项目的 `target-dir`。用户态插件也拿不到整盘写入审计，所以判据必须从"猜哪棵树"换成"**记录这个会话自己点名了哪些写路径，再把这些路径长出来的子树纳入统计**"。

## 3. 目标与非目标

目标：

- 工作区之外的产物，只要会话的工具调用点名过（`cd X`、`-o X`、`--target-dir X`、文件工具的 `file_path`、`working_directory cd`），就进入报告；
- 报告能把"工作区"与"工作区外"分开看，也能给总数；
- 发现、归因、预算、截断都有明确规则，读数不会因为"发现得晚"而丢失或重复；
- 子会话的产物并进根会话。

非目标：

- **不**做全盘写入审计。没有任何工具调用点名、也不在任何已登记根下的路径（二进制里写死的路径、后台 daemon 的 state 目录）不可观测，需要 OS 级手段（`fs_usage` / EndpointSecurity / seatbelt 日志），不做进插件；
- **不**执行删除、移动、清理，仍然只做测量；
- **不**扫描整个家目录、`/tmp` 全量、`/System` 等，避免一次幻觉把机器扫一遍。

## 4. 可用的写入证据

DSH 里能观测到"会话写了什么"的只有三处：

| 证据 | 精度 | 覆盖 | 代价 |
|---|---|---|---|
| 工作区树 diff（现有） | 精确（但有目录 mtime 的限制） | 任何进程写进 `cwd` 的东西，含 `bash` 构建产物 | 已有 baseline + 增量，约 150 ms/回合 |
| `fs/write-intent` / `fs/edit-intent` / `fs/delete-intent`（[fs/src/index.ts](../../deepseek-harness/packages/fs/fs/src/index.ts#L66)） | 精确到目标文件 | 所有走 `ctx.fs` 的写入（`write` / `edit` / `apply_patch`），**不限位置** | 每次写入一次拦截 |
| `tools/pre-execute`（[tools/src/events.ts](../../deepseek-harness/packages/core/tools/src/events.ts#L18)） | 启发式 | `bash` / `pwsh` 命令串里的 `cd`、`workdir`、输出参数、重定向；`working_directory` 的 `cd` | 每次工具调用一次解析 |

第三项是通用方案的关键，也是它诚实的上限：**命令文本里出现过的路径才看得见**。`/tmp/memcmp` 这种场景几乎必然命中，因为 `cd /tmp/memcmp`、`go build -o /tmp/memcmp/app`、`--target-dir /tmp/memcmp/target`、`mkdir -p /tmp/memcmp` 至少有一个会出现在命令里。

## 5. 根的模型

每个会话维护一个**根集合**，工作区根是其中一个：

```ts
interface ArtifactRoot {
  /** 绝对路径；存在后按真实路径规范化（macOS 上 /tmp 是 /private/tmp 的符号链接）。 */
  path: string
  /** 展示前缀：工作区根为空串，其余为绝对路径。 */
  label: string
  /** 从哪里发现：workspace | working-directory | tool-argument | fs-intent | declared | configured | subagent。 */
  origin: ArtifactRootOrigin
  /** 本根的 baseline；不存在（pending）时为空。 */
  baseline: Promise<InventoryBaseline | undefined>
  /** 归因水位：文件 mtime 晚于它才算本次会话产生。 */
  since: number
  /** 严格归因：每个候选文件都要过 mtime 检查（工作区外一律严格）。 */
  strict: boolean
}
```

生命周期：

1. **登记**：`session/created` 登记工作区根；`working-directory/change`、工具调用、fs 写意图、`session_artifacts_watch`、`extraRoots` 登记其余根。
2. **规范化**：存在时 `realpath`，不存在时保留词法路径，首次出现再规范化。
3. **去重与包含**：候选根被已有根包含 → 丢弃（外层覆盖它，工作区根也算外层）；候选根包含某个工作区外的已有根 → 用外层替换内层（内层 baseline 丢弃）；候选根是工作区根的祖先 → 拒绝并记录一条警告（否则工作区内容会被算两遍）。
4. **pending**：根不存在时挂起，每回合一次 `stat`；出现后按空 baseline 处理，里面的一切都是新内容。
5. **释放**：`session/disposed` 清空。

准入拒绝（任一命中即不登记，并计入 `rejected` 诊断计数）：

- 文件系统根、家目录本身、家目录的直接子目录（`/Users`、`/home`）；
- 系统前缀：`/System`、`/Library`、`/Applications`、`/usr`、`/etc`、`/private/etc`、`/private/var/db`、`/bin`、`/sbin`；
- 非本地路径（远程 / 虚拟 fs 的 `processPath` 可能是 URI 而不是本地绝对路径，只登记 `isAbsolute` 的本地路径）；
- 含关系冲突（见上文生命周期第 3 条）。

## 6. 发现器

### 6.1 工具调用（`tools/pre-execute`）

`exec.arguments` 已经是解析后的对象，不需要再解析 JSON。监听器只做记录并立即 `next()`，不改变放行决策。按工具名取路径：

| 工具 | 取法 |
|---|---|
| `write` / `edit` / `str_replace_editor` | 参数 `file_path` → 目标文件 → 登记其父目录 |
| `apply_patch` | 不解析补丁正文（fs 写意图已精确覆盖） |
| `working_directory` | `cd` → 新根 |
| `bash` / `pwsh` | 见下 |
| `present` | 注册/交付的文件路径 → 父目录 |

`bash` / `pwsh` 的 `command` 用一组**写入语境**取路径，宁可少取也不把读路径算进来：

- `cd <path>`、`pushd <path>`；
- `workdir` 参数；
- 输出参数：`-o <path>`、`--output <path>`、`--out-dir <path>`、`--target-dir <path>`、`--prefix <path>`；
- 建目录：`mkdir -p <path>`、`install -d <path>`、`mktemp -d [template]`；
- 重定向：`> <path>`、`>> <path>`、`2> <path>`、`&> <path>`；
- 复制/移动的目标：`cp ... <dest>`、`mv ... <dest>`、`ln -t <dir>`、`rsync ... <dest>`、`tar -C <dir>`；
- 命令里出现的裸绝对路径：只在一行同时含写入语境时才取（否则 `cat /etc/hosts` 会把系统目录拖进来）。

取到的路径按"目标"处理：

- 已存在且是目录 → 就是根；
- 不存在或不是目录 → 取父目录（父目录也不存在时继续向上，最多三层，仍不存在则挂 pending 在词法路径上）；
- 相对路径 → 先按会话当前工作目录解析，再按上一条处理。

解析失败、路径含变量（`$TMPDIR/...` 展开后无法确定）、或长度异常时：跳过并计数，不猜。

### 6.2 fs 写意图（`ctx.inject(['fs'])`）

`fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` 上挂监听，用 `ctx.fs.processPath(target)` 拿绝对目标，登记父目录。这是唯一"精确到文件"的来源，覆盖文件工具写到工作区之外的情况。

注意：`bash` 里的写入不经过 `ctx.fs`，只能靠 6.1。

### 6.3 其他来源

- `working-directory/change`（[working-directory/src/index.ts](../../deepseek-harness/packages/session/working-directory/src/index.ts#L34)）：新 `cwd` 成为新根；旧 cwd 不撤销（它可能已经装了产物）。
- `session_artifacts_watch(path)`（新工具）：模型在"我知道要往哪写"时自己声明，避免解析命令。返回该根当前的测量值。
- `extraRoots` 配置：会话开始时登记的固定根，给"永远不点名也要看"的位置。
- 子会话：见第 8 节。

## 7. 归因

根分两种归因模式：

- **工作区根**（现有行为）：未知文件一律算新增（`cp -p` 保留旧 mtime 也算），已知文件按 `mtime > takenAt` 算重写。
- **严格根**（工作区外）：每个候选文件都必须 `mtime > root.since` 才计入；`since` 取**会话开始**，不是发现时刻。这样"根是在东西写完之后才被提到"也能把里面本次会话写的算进来，而根里原本就有的旧文件不会。

严格根同样要给 `measureSubtree` 传 `since`：新建子树的测量也只能把 `mtime > since` 的文件计入，否则"发现晚"的根里原有内容会被整片算成新增。

已知边界：

- `cp -p` / `rsync -a` 保留旧 mtime 的复制，在严格根里会漏（工作区根不会）；
- 会话期间别的进程写进同名根的文件会被多算。这是"根由会话点名"这个前提换来的风险，报告里用 `origin` 标注来源，让读者能判断。

## 8. 子会话聚合

- 每个 Session 仍然拥有自己的根集合；`header.parentSession` 把会话连成树。
- 根会话的报告 = 它自己 + 全部后代会话的根并集；同一个根被多个会话登记时只算一次（按规范化路径去重）。
- 子会话的扫描照常跑（它自己的回合结束触发），根会话在回合结束汇总各部分最近一次扫描结果；子会话还在跑时，它这一回合新写的先按"下次根会话扫描"计入。
- 归属展示：`FolderEntry` 的顶层行带 `root` 与 `sessionId`，面板可以标注"来自子会话"。

## 9. 扫描与预算

- 每回合对每个根跑一次现有 `scanWorkspace` —— 它本来就以 `baseline.root` 为参数（[src/inventory.ts](../src/inventory.ts#L248)），多根复用不需要改扫描器；新增两个可选参数：展示前缀与严格归因。
- 预算共享：一个回合的总预算 = `timeoutMs`，所有根合计最多 `maxDirectories`、`maxRecords`。根的顺序：工作区优先，其余按发现顺序；预算耗尽时在报告里标 `truncated`。
- `ScanTruncation.reason` 增加 `maxRoots`：根数超过 `maxRoots` 时，超出的根不登记，`limit` = 配置值，`observed` = 尝试数。
- 单个根太大：它的扫描照样受 `maxDirectories` / `maxRecords` 约束，截断原因按现有规则给出。

## 10. 报告与展示

数据形状（向后兼容）：

```ts
interface ScanRecordData {
  // 现有字段不变
  root?: string            // 仍是工作区根，旧客户端读它
  bytes: number            // 语义变为"全部根合计"；工作区内的量另给
  // 新增
  roots?: readonly RootShare[]   // 每个根的展示名、字节数、文件数、来源
  workspaceBytes?: number        // 其中工作区部分
}
```

- `ObservedEntry.display`：工作区内仍相对工作区；工作区外为绝对路径（现有 `locate` 已能给出）。
- `recordFolders` 的顶层划分不再只靠写死的 `KNOWN_ARTIFACT_DIRS`（[src/index.ts](../src/index.ts#L188)）：工作区根沿用现有启发式；工作区外的条目以所属根为顶层行，路径为绝对路径。否则 `/private/tmp/memcmp` 会被折成一行 `/private/tmp`。
- 状态行与面板：总产物旁边加拆分（"总产物 734 MB · 工作区 234 MB · 工作区外 500 MB"），面板按根分组，每行仍可展开、仍可"在默认应用中打开"（外部根没有 `.idea` 时 `openTarget` 原样返回，访达打开）。
- 记录卡片（`session_artifacts_report`）多一行根清单：路径、来源、字节数。
- 中英文文案共用同一份数据结构，新增 `roots` 的两种语言文案。

## 11. 配置

| 配置项 | 默认值 | 作用 |
|---|---:|---|
| `maxRoots` | `8` | 一个会话最多登记的根数（含工作区） |
| `discoverRoots` | `true` | 是否从工具调用与 fs 写意图发现外部根 |
| `extraRoots` | `[]` | 会话开始时登记的固定根，只接受绝对路径；建议给窄路径（`/tmp/memcmp`），不要给 `/tmp` |
| `maxDirectories` / `maxRecords` / `timeoutMs` | 不变 | 所有根共享 |

`extraRoots` 与 `session_artifacts_watch` 是兜底，不是主路径：主路径是自动发现。

## 12. 失败模式与降级

- **没有 `fs` 服务**（无头或精简组合）：跳过 6.2，其余照常；插件仍可用。
- **工具参数解析失败**：跳过该调用并计数，不猜测路径。
- **根被删除**：记录消失，足迹下降（与工作区现有行为一致）。
- **权限不足**：该子树跳过（现有 `catch` 行为），诊断计数 +1，报告不静默当作 0。
- **远程 / 虚拟文件系统**：非本地绝对路径不登记。
- **Windows**：统一走 `node:path`；盘符路径按绝对路径处理，`extraRoots` 同样要求绝对路径。

## 13. 兼容性

- 旧记录没有 `roots` / `workspaceBytes`：客户端退回只显示工作区读数（现有行为）。
- `bytes` 语义从"工作区足迹"变为"全部根足迹"：这是本设计要的；为不让旧读者误解，`workspaceBytes` 同时给出，UI 文案区分。
- 旧客户端遇到未知的 `truncation.reason = maxRoots`：现有渲染按"配置上限"一句话兜底（[src/index.ts](../src/index.ts#L756)）。

## 14. 测试计划

单元：

- 命令路径抽取表驱动：`cd`、`-o`、`--target-dir`、重定向、`mkdir -p`、`mktemp -d`、`cp` 目标、裸绝对路径只在写入语境下取；`cat /etc/hosts` 不产生根；
- 准入拒绝：`/`、`$HOME`、`/Users`、系统前缀、远程 URI；
- 包含关系：外层登记后内层丢弃；内层先登记、外层后到时替换且不重复计数；
- 规范化：`/tmp` 与 `/private/tmp` 视为同一个根；
- 严格归因：旧 mtime 不计、新 mtime 计、新建子树的旧文件不计、工作区根行为不变；
- pending 根：不存在时不报错，出现后整棵计入。

集成（沿用 `tests/*.test.mts`，经 `lib/` 构建产物）：

- 工作区外临时目录 + 模拟 `bash` 的 `cd` 调用 → 报告包含绝对根行与字节数；
- 模拟 fs 写意图到工作区外 → 计入；
- 子会话：子会话写出的根出现在根会话报告里，且同一根不重复；
- 截断：`maxRoots` 触发时 `reason` / `limit` / `observed` 正确。

客户端（`client.test.mts` 风格）：

- 面板按根分组、绝对路径行可展开、打开入口发出绝对路径。

## 15. 实施顺序

1. **第一步（核心）**：根模型 + 工具调用/fs 写意图发现 + 严格归因 + 多根扫描 + 报告与面板展示。不含子会话、不含 `session_artifacts_watch`。
2. **第二步**：子会话聚合（`parentSession`）与归属标注。
3. **第三步**：`session_artifacts_watch` + `extraRoots` + 文案与 README 更新。

每步都可独立验证：第一步做完，`/tmp/memcmp` 场景就应出现在报告里。

## 16. 需要同步更新的文档

- `README.md`：读数定义（足迹不再只指工作区）、配置表、新工具、边界说明；
- 本文件的状态从"草案"改为"已实现"，并记录实测数据（例如 `/tmp/memcmp` 500 MB 场景的扫描耗时）。

## 17. 实现结果与残余边界

已落地：根模型与准入、工具调用/fs 写意图/`working-directory` 发现、严格归因、多根扫描与共享预算、子会话聚合、`session_artifacts_watch`、`extraRoots`、报告与面板的拆分和按根分组。测试覆盖：根解析与准入、严格归因、外部根集成、子会话聚合、`watch`、记录与面板（`npm test`，84 个用例）。

仍然存在、且有意不做的边界：

- **命令词法只覆盖常见写法**：`cd` / `pushd` / `mkdir` / `install -d` / `mktemp -d` / `cp` / `mv` / `ln` / `rsync` / `tar -C`、`-o` / `--output` / `--target-dir` 等输出参数、重定向，以及写入语境里的裸绝对路径。`tee`、`git clone` 的目标、脚本内部算出来的路径不在内——它们要么靠 fs 写意图，要么就落在盲区。
- **没有 cwd 的子会话不聚合**：`ensure` 以 `session.header.cwd` 为准，没有工作目录的 Session 没有根集合。
- **`run_code` / workflow 脚本里的路径不被解析**：它们不是 shell 命令文本，写到哪只能靠 fs 写意图（PTC 沙箱内的写入不经过 `ctx.fs`）或 `extraRoots`。
- **保留 mtime 的复制**（`cp -p` / `rsync -a`）在工作区外的严格根里会漏计，因为归因只看 mtime。
- **Windows 未实测**：系统前缀表是 POSIX 的；盘符路径按绝对路径处理，`extraRoots` 同样要求绝对路径。
- **`extraRoots` 的宽路径会被拒**：`/tmp`、`/private/tmp` 这类共享目录过不了准入（深度不足），这是有意的；要登记就写窄路径。

