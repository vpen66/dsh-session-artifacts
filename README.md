# dsh-session-artifacts

一个 DeepSeek Harness 插件，用来回答一个简单的问题：本次 Session 产生了多少磁盘产物，以及这些空间主要在哪些文件夹里。

插件只做观察和统计，不判断文件应该保留还是回收，也不执行删除、移动或清理。需要释放空间时，可以把报告中的文件夹和大小交给 AI，由 AI 根据当前任务决定清理方式。

统计的根不只是工作区：这个 Session 的工具调用点名过的路径（`cd`、输出参数、重定向、文件工具的目标）、`working_directory` 切换到的目录、子会话的工作区，都会成为额外根。每个根各有一份基线，回合结束时一起扫描，报告里分开给出"工作区"和"工作区外"。

## 提供的能力

插件在**会话被创建/载入时**立刻开始走一遍工作区，把它作为这个 Session 的基线；此后每个回合结束后扫描新增或被重新写入的内容，与基线比较。基线必须早于第一回合，否则第一回合自己构建出来的东西会被算进基线、报成"没产出"。基线是异步走的，若某次扫描在它走完之前开始，扫描会等它走完而不是直接跳过这一回合。扫描结果按文件夹汇总：

- 记录的**单位是目录**：某个目录在本回合新增或被重写了多少文件、多少字节，就记一条；新建的目录按目录自身统计递归大小并记一条；直接躺在工作区根目录下的文件仍然各自一条（它没有自己的文件夹可归）；
- 每条记录带**最后写入时间**（文件的 mtime / 新目录里最新的 mtime / 目录记录里最新的 mtime），"本回合"这个读数就是靠它从同一批记录里筛出来的；
- 文件按其父文件夹统计；
- 新产生的目录按目录自身统计递归大小；
- 每个文件夹展示占用字节数和覆盖的文件数；
- **工作区外的根只按写入时间归因**：根往往是会话中途才被发现的，所以它里面 `mtime` 晚于会话开始的文件才算这次会话产生的，根里原本就有的旧文件不会；新建子树的测量同样按这条水位过滤；
- **根有准入**：文件系统根、家目录及其上级、系统目录、非本地路径（远程 / 虚拟文件系统的 URI）都不登记；根数超过 `maxRoots` 时，超出的根不登记，报告标 `maxRoots` 截断；
- 总大小始终由扫描结果计算，即使明细触发了数量上限，也会返回 `truncated` 与 `truncation`（哪条上限、上限值、实际到达多少）告知列表可能不完整；
- 目录按占用空间从大到小排列，方便先定位最大的产物。

一次扫描给出两个读数，含义不同、不可互换：

| 读数 | 记录字段 | 含义 | 构建回合 | 安静回合 |
|---|---|---|---:|---:|
| **本回合** | `turnBytes` | 本回合新增/重写的字节数 | 155 MB | 0 B |
| **产物** | `bytes` | 本会话至今留下的产物总量，工作区与工作区外的根合计（足迹；文件被清理后会下降） | 155 MB | 155 MB |

足迹不能靠相减得出本回合：一棵被重建的 `target/` 在之后的每次扫描里依然"还在、还是本会话写的"，所以它一直计入足迹——区分两者的是每条记录自己的写入时间。

按目录记账是为构建服务的：`mvn clean verify` 会把 `target/` 里已有的几百个文件逐个重写，如果每个文件都记一条，一次健康的构建就会在上限面前变成"清单不完整"；按目录记则一个 `target/` 就是一条，读者看到的一行还是一样（文件夹、字节数、文件数）。

扫描只进入配置允许的目录，并有目录数量、记录数量和耗时上限；这些上限由所有根共享，一个回合的总预算仍是 `timeoutMs`。基线和增量扫描都通过遍历文件系统完成，因此可以看到通常被 Git 忽略的 `build/`、`dist/`、`target/`、`node_modules/` 等目录。基线扫描自己的上限结果不会被后续扫描使用（基线未跑完时，增量扫描会把未记录的目录当成新内容），因此工作区很大时应同时放宽 `maxDirectories` 与 `timeoutMs`。

**看不见的部分**：用户态插件没有整盘写入审计，只有"会话自己的工具调用点名过的路径 + 这些路径下长出来的子树"能被覆盖。程序把东西写到没有任何工具调用点名、也不在任何已登记根下的路径（例如二进制里写死的绝对路径、后台 daemon 的 state 目录），不会出现在报告里；需要 100% 覆盖时要靠 OS 级写审计（`fs_usage` / EndpointSecurity / seatbelt 日志），本插件不做。另外 `cp -p` / `rsync -a` 这类保留旧 mtime 的复制，在工作区外的根里会漏计。

## 模型工具

插件注册两个工具：

### `session_artifacts_report`

返回：

```json
{
  "root": "/workspace/project",
  "bytes": 157286400,
  "truncated": false,
  "foldersTotal": 2,
  "folders": [
    { "path": "target", "bytes": 150000000, "files": 320 },
    { "path": "dist", "bytes": 7286400, "files": 48 }
  ]
}
```

触发上限时额外返回 `truncation: { "reason": "maxRecords", "limit": 600, "observed": 799 }`，`reason` 取 `maxRecords` / `maxDirectories` / `timeoutMs`，`observed` 与 `reason` 同单位（记录条数 / 目录数 / 毫秒）。

工具的文本输出里，截断读作两行：一句人读的话（固定以 `The scan stopped` 开头，便于旧客户端识别），加一行 `truncated<TAB>reason<TAB>limit<TAB>observed` 供卡片本地化。

这个工具没有副作用。它不生成回收计划，不返回 `keep`、`reclaim` 或 `review`，也不会自动回收任何文件。

### `session_artifacts_watch`

让模型在"知道自己要往哪写"时显式声明一个根，而不必等命令文本里出现路径：

```json
{ "path": "/tmp/memcmp" }
```

返回该根当前的 `{ path, counted, bytes, files }`。路径可以是绝对路径，也可以相对工作区根；被准入规则拒绝时 `counted` 为 `false`。声明不移动回合的归因水位，所以它只影响统计，不影响每回合读数。

## 客户端展示

两个读数分居两处，各有各的位置：

- **每条助手消息的操作行**里显示 **`产物 155 MB`** —— 这一回合写入工作区的量，字号与同行「用量 … tok」一致；点开和底部那个一样，展开面板列出**这一回合**写入的文件夹（标题「本回合产生的产物」），每行同样有「在默认应用中打开」入口。它注册在宿主给逐条动作留的座位（`conversation.chat.assistant-actions`）上，而这个座位在分支按钮之前，所以读数用 flex `order: 99` 让自己排在这一行的最后：`复制 → 其它逐条动作（点赞/举报等）→ 分支 → 🗄 用量 … tok → 时间 → 产物`。要落在「用量」与「时间」之间，需要宿主给这一行另开一个座位（`MessageIconActions` 的 `usageAction` 之后），插件自己够不到那个位置。这条读数的归属靠插件自己发布的记录里的 `messageId` 对上（回合结束时的 `assistant/message`），不依赖宿主节点内部结构；
- **输入框下方的状态行**显示 **`总产物 155 MB`** —— 本会话留下的产物总量（工作区 + 工作区外）；存在工作区外的根时，面板顶部再给一行拆分（`工作区 234 MB · 工作区外 500 MB`），并按根分组，工作区外的组带一行形如 `工作区外 · /private/tmp/memcmp` 的标题；
- 两个读数都按根分组展示：工作区的行沿用原来的顶层划分（`target/`、`dist/` 这类产物目录），工作区外的行以根的绝对路径为顶层行，避免 `/private/tmp/memcmp` 被折成 `/private/tmp`；
- 新建目录（会话基线里还没有的目录，例如本次首次构建出来的 `xxx/target`）同样**逐层上报**：每个直接放着文件的子目录各成一条记录，所以它也能一层层展开；只有整棵树超出记录预算时才退回「一条子树记录」——单棵树最多用掉剩余记录额度的一半，`node_modules` 这种几千个子目录的树因此仍然折叠成一条；
- 面板里的目录是**逐层展开的树**：展开一个文件夹只显示它**直属**的子目录（每行用目录自己的名字，完整路径在 tooltip 里），每个子目录还能继续展开，和访达一样；子目录行的字节数是它自己的子树总量，不会因为展开而重复计算；
- 报告卡片（模型调用 `session_artifacts_report` 时）显示完整的文件夹统计，并提示扫描是否触发上限；
- 触发上限时，报告卡片说的是**哪条上限**、以及实际到了多少（例如「一次扫描最多记录 600 条，本回合已记录 799 条」）；操作行放不下提示，所以那条句子写进读数自己的 tooltip，读数本身只显示数字；
- 旧宿主送的记录里没有 `turnBytes` 时，操作行那条读数退回显示足迹，读数不会消失；
- 中英文文案共用同一份数据结构。

宿主支持插件记录 API 时，两个读数都读取 `plugin:session-artifacts/scan` 记录（同一份记录里的 `turnBytes` 与 `bytes`）。旧宿主没有这个 API 时，报告工具仍然可用，只是不会持久化这两个读数。设置里的开关控制操作行上那条读数是否出现。

### 打开文件夹时交给应用哪个路径

打开入口使用会话头部「Open In…」记住的应用（`localStorage` 键 `dsh.open-in-app.choice`，缺省 `finder`），并把目录交给宿主的 `open-in-app/open`。交给它哪个路径由本插件的 `session-artifacts/open-target` 路由决定：

- 访达、VS Code、终端等「把文件夹当文件夹」打开的应用，收到点击的目录本身 —— 新窗口正是它们的正常行为；
- IntelliJ 平台的 IDE（IDEA、PyCharm、WebStorm、PhpStorm、GoLand、Rider、RustRover、Android Studio）会「把目录当工程」打开，因此收到的是该目录所属的**工程根**（向上找到最近的、含有效 `.idea` 的目录）。这样 IDE 已经打开该工程时复用并置前现有窗口，不会再为 `artisan/target` 这类产物另开一个工程窗口；IDE 没有打开该工程时，打开的也是正确的工程而不是产物目录。

点击的目录本身不属于任何工程，或所选应用不是 IntelliJ 平台 IDE 时，路径原样交给宿主。宿主没有这条路由（旧宿主、无 Web 服务器的组合、请求被拒）时，客户端退回点击的目录，行为与加这条路由之前完全一致。

## 宿主路由

插件在有 Web 服务器和连接服务时注册一条路由（`ctx.inject(['webServer', 'connection'], …)`，因此无头组合仍然只有报告工具）：

### `POST /session-artifacts/open-target`

请求体：`{ "app": "intellij", "path": "/abs/path/to/folder" }`；响应：`{ "path": "/abs/path/to/project" }`。

- 路由先经组合的 `connection.requestRejection` 信任栅栏，再校验请求体：`application/json`、64 KiB 上限、字符串字段、绝对路径；
- 它只读取所给路径的上级目录以寻找 `.idea` 标记，不启动任何程序、不修改任何文件；
- 家目录和文件系统根目录永远不算工程根。

## 配置

配置通过插件 Profile Patch 传入，默认值如下：

| 配置项 | 默认值 | 作用 |
|---|---:|---|
| `maxDirectories` | `50000` | 一次扫描最多访问的目录数（基线走不完时，后续增量扫描会把未记录的目录当成新内容） |
| `maxRecords` | `600` | 一次扫描最多保留的目录级记录数；报告会在此基础上汇总文件夹。它也决定「逐层展开」能有多细：新建目录逐层上报时，单棵树最多用掉剩余额度的一半 |
| `timeoutMs` | `5000` | 一次扫描的最长耗时 |
| `exclude` | `[".git", ".hg", ".svn"]` | 永不进入的目录名 |
| `scanOnTurnEnd` | `true` | 是否在每个回合结束时自动扫描 |
| `recordFolders` | `12` | 每条回合插件记录携带的最大文件夹数；总数仍通过 `foldersTotal` 保留 |
| `maxRoots` | `8` | 一个会话最多登记的根数（含工作区）；超出时报告标 `maxRoots` 截断 |
| `discoverRoots` | `true` | 是否从工具调用与 fs 写意图发现工作区外的根；关掉后只剩工作区、`working_directory` 切换、显式声明与 `extraRoots` |
| `extraRoots` | `[]` | 会话开始时登记的固定根（绝对路径）；给那些"永远不点名也要看"的位置，建议窄路径（`/tmp/memcmp`）而不是 `/tmp` |

## 开发和验证

```bash
npm run typecheck
npm run build
npm test
```

开发环境可以通过 `dev.patch.yml` 挂载 `src/index.ts`，打包配置通过 `cordis.patch.yml` 挂载 `dsh-session-artifacts`。

插件分两半，改动的生效方式不同：

- 宿主半（`lib/`，`npm run build` 产出）在 Host 启动时加载，改完要重启 Desktop 应用或对应的 `dsh web` 进程；
- 浏览器半（`client/client.js`，不进构建）随页面加载，改完刷新页面即可（Web 的 plugin preload 带 `rev`，文件变了就会重新取）。

## 仓库结构

| 路径 | 作用 |
|---|---|
| `src/` | 宿主半源码：`index.ts`（插件入口、两个工具、回合记录、路由）、`roots.ts`（根的发现与准入）、`inventory.ts`（扫描、基线与归因）、`openTarget.ts`（打开路径规则）、`types.ts`（共享类型） |
| `lib/` | `npm run build` 的产物，`package.json` 的 `main` / `types` 指向这里；不入库 |
| `client/client.js` | 浏览器半，手写、不进构建，随页面加载 |
| `tests/` | `node --test` 用例，导入的是 `../lib/*.js` |
| `docs/` | 设计文档，见下方「相关文档」 |
| `cordis.patch.yml` | 打包用 Profile Patch，按包名 `dsh-session-artifacts` 挂载 |
| `dev.patch.yml` | 开发用 overlay，按绝对路径挂载 `src/index.ts` |
| `install-desktop.sh` | 构建 `lib/` 后装进 Desktop 保留的 profile |
| `.verify/` | 本地验证残留（截图、抓取的页面与 JSONL、cookie），不入库 |

## 测试

五个文件按被测的那一层分开：

| 文件 | 覆盖 |
|---|---|
| `tests/roots.test.mts` | 从命令文本与工具参数里取路径、准入拒绝、路径规范化、根的包含关系 |
| `tests/scan.test.mts` | 目录级扫描、基线、严格归因、预算与截断 |
| `tests/wiring.test.mts` | `apply` 注册了哪些面、卸载时释放了什么（stub context），以及记录的文案 |
| `tests/client.test.mts` | 直接 `import('../client/client.js')`，覆盖浏览器半的渲染与文案 |
| `tests/openTarget.test.mts` | 点击的目录该交给应用哪个路径 |

用例导入的是 `lib/*.js`，所以 `npm test` 测的是**上一次构建**的结果：改过 `src/` 要先 `npm run build`。只跑一个文件：

```bash
node --test tests/roots.test.mts
```

`npm run typecheck`（`tsconfig.json`，`noEmit`）与 `npm run build`（`tsconfig.build.json`，出 `declaration` 到 `lib/`）都只 `include` 了 `src`，测试文件不参与类型检查。

## 宿主侧依赖

只有 `tools` 是必需的（`export const inject = ['tools']`），其余按组合里有没有该服务决定：

| 服务 | 缺失时的行为 |
|---|---|
| `fs` | 不挂 `fs/write-intent` / `edit-intent` / `delete-intent`，工作区外的根只剩命令文本这一条发现途径 |
| `webServer` + `connection` | 不注册 `POST /session-artifacts/open-target`，打开入口原样使用点击的目录（无头组合即属此类） |
| 插件记录 API | 不持久化 `plugin:session-artifacts/scan`，操作行与状态行的读数不出现；报告工具与 `session_artifacts_watch` 照常可用 |

## 相关文档

- [docs/session-artifact-roots.md](docs/session-artifact-roots.md)：根模型、准入规则、严格归因、子会话聚合、共享预算与截断的设计文档。第 17 节列了仍然存在的能力边界：命令词法只覆盖常见写法、`cp -p` / `rsync -a` 在严格根里漏计、Windows 未实测、`run_code` / workflow 脚本里的路径不被解析。
