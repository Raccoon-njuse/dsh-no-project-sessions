# 在 dsh 中验证插件

这份文档记录 **dsh-no-project-sessions** 实际用过的验证方法：装完之后怎么确认它真的在跑、页面在哪看、哪些东西根本验证不了。

原则只有一条：**用能力证明，不用截图证明。**

> 记录时间 2026-11-04，DSH 0.2.x Desktop，本地 profile `desktop`（`~/.dsh/profiles/desktop`）。
> 文中的「实测」都指这台机器上当场跑出来的结果，不是文档抄来的。

## 1. 三层通道

| 层 | 手段 | 能证明什么 | 是否需要批准 |
| --- | --- | --- | --- |
| 安装 | `plugin_manager` 的 `install_bundle` 返回值 | 变更是否**已生效**：只看 `application` 与 `warnings` | 可能需要 |
| Host | `cordis_inspect_query` `platform: host` | row 在不在 loader、Config 解析结果、Host 服务、Agent 能调到的 Tool | 免批准（只读） |
| Client | `cordis_inspect_query` `platform: client` | 页面里**真的注册了**什么：Slot、occupants、Service、theme token | 免批准（只读） |

Client 查询会**转发进真实页面、由页面作答**。这是唯一能证明「UI 真的挂上去了」的免批准通道，也是平时用得最多的一条。

安装是否成功，只有 `application: applied` 算证据。日志、进程列表、页面 boot payload 都不算。

## 2. 判定规则（踩过的坑）

### 2.1 `Config.listConfigs` 的 `status` 不是活性

实测：

- `name=dsh-no-project-sessions` → `status: "absent"`
- 同一时刻 Host 半其实在跑（见 §3.1 的路由探测）

`status` 只是 Config 投影的状态（`tree` / `schema` / `inactive` / `absent`），表示这一行在**配置投影**里是什么样子，不能拿来判断插件是否加载。活性要另证：路由响应、Service 存在、Slot occupant `active`。

### 2.2 Slot occupant 的 `registrant` 不是包名

实测 `conversation.hero.workspace` 的两个 occupant 都显示 `registrant: "Gb"` —— 打包后的局部标识。认自己只能靠 **priority 和注册时机**，不能靠名字。

### 2.3 判断 Host 路由是否存在：比状态码，不比 200

本机实测，对着 GUI 端口直接发请求：

```text
GET  /                          → 401   Web 鉴权闸门
GET  /dsh-no-project/config     → 401   路由存在，handler 里 requestRejection 拒绝
POST /dsh-no-project/prepare    → 401   同上
POST /definitely-not-a-route    → 405   未注册路由的兜底
```

`401` 与 `405` 的差别就足以证明「路由注册了，鉴权也生效了」，而且不需要任何 token。想再确认方法限制：`GET /dsh-no-project/prepare` 应得 `405`（handler 显式 `allow: POST`），`DELETE /dsh-no-project/config` 应得 `405`（`allow: GET, POST`）。

## 3. 本插件的检查清单

### 3.1 Host 半

| 检查 | 怎么查 | 期望 |
| --- | --- | --- |
| Bundle 在组合里 | `dsh --profile "$DSH_PROFILE" --dump-config`，或看 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` | 有 `dsh-no-project-sessions` |
| Config schema 已投影 | `host/Config` `listConfigs` `name=dsh-no-project-sessions` | `status: "schema"`；若是 `"unsupported"` 说明 `Config` 不是原生 Schemastery 图，插件页的配置卡不会渲染 |
| 路由注册 + 鉴权 | 上面 §2.3 的 `401` / `405` 对照 | `401` |
| 设置保存 | 插件页保存一个目录后 `GET /dsh-no-project/config` | `root` 为新值，profile 里该行 `config.scratchRoot` 同步变化 |
| 无编辑器时拒绝 | 在没有 `configEditor` 的 profile 里保存 | `501` + 「无法保存插件配置」，**不得**谎报成功 |
| 工作区注册 | 侧栏应出现配置目录对应的分组，标题 `最近` | 存在，且在真实项目之后 |
| 目录预留 | `<草稿根>/<YYYY-MM-DD>/<slug>[-n]` | 首条消息发出后创建，slug 来自消息前 6 段 ASCII |
| 并发只留一份 | `node tests/host.test.js` 的 `concurrent same-session requests allocate and commit exactly one directory` | 恰好一个目录、一次提交 |

`workspaceRegistry` / `agents` / `workingDirectory` / `webServer` / `connection` 这五个注入项可以用 `Service.listService` 确认签名没变；签名变了说明宿主升版，得先修再验。`configEditor` 是可选依赖（`ctx.get('configEditor')`），缺失时只影响保存能力，不影响插件加载。

### 3.2 Client 半

```jsonc
// 页面里到底有没有我们的 shadow 注册
{ "platform": "client", "provider": "Slots", "method": "listSubTree",
  "input": { "root": "conversation.hero.workspace" } }
```

期望 occupants 两条：

- `priority: -1, active: true` —— 我们注册的菜单，**正在生效**
- `priority: 0, active: false` —— 宿主的原版，被压住

这是「UI 半挂上了」的判据。注册本身没挂上时，只会剩一条 `priority: 0`（0.2.2-rc.3 上修复前实测就是这一条）。

设置卡单独查：

```jsonc
{ "platform": "client", "provider": "Slots", "method": "listSubTree",
  "input": { "root": "plugins.bundle.config" } }
```

期望该 keyed slot 的 `key` 集合里有 `dsh-no-project-sessions`；插件详情页才会渲染出配置区。

其它可以顺手确认的：

- `Slots.listSubTree` `root: conversation.hero.workspace.directoryFlow` —— 子槽在但空着。本插件的菜单只列 workspace，不渲染宿主 folder picker，这是已知取舍。
- `Theme.listTokens` —— 样式里用到的 token 名是否存在。本插件只用宿主 token：`--dsw-alias-label-tertiary` 和宿主提供的 `--dsh-workspace-indent`。
- `locale` 字典：中英两套 key 必须齐（`noProject` / `workspace.defaultName` / `chooseProject` / `newProject`），缺一个就是界面上一段英文混中文。
- 卸载路径：`ctx.effect` 的清理要真的回收 —— 移走 `<style>`、断开 `MutationObserver`、还原被替换的 chip 文本节点（`data-nps-replaced` / `data-nps-original`）并摘掉 `data-nps-scratch`。热更新后如果还留着旧样式或错字，说明清理没写对。

**不再有 primitives 例外：** 旧版 `require("@deepseek-ai/dsh-client-ui-primitives")` 取 `Menu` 的做法已在 v0.3.0 移除，改为自绘 `.npsMenu`（portal + Escape + 外部点击关闭，只用宿主 token）。客户端插件不该 import 宿主 Client 包：它们的 props 会不打招呼地变，而且一个抛异常的入口会把整个 slot 条目变空白（console 里是 `slot entry crashed in '<slot>'`）。`dsh.client.inject` 只用于排序激活。

### 3.3 视觉检查（DOM restyle 的两处例外）

本插件有两处绕开了 Slot，纯 DOM 实现。这两处 inspect 看不见，只能看页面：

1. **侧栏组头**：`[data-row-key="workspace:<id>"]` 被改成 36px 的分区标题样式（这一版宿主没有 workspace 组头的 Slot）。
2. **Hero 里的 workspace chip**：`[class*="heroWorkspaceRow"]` 里的标签文本节点被就地换成「选择项目」（保留宿主原生字号/行高/宽度），并把 chip 图标与文字调成 secondary 占位色；不改工作区标题，因此侧栏组头不受影响。

检查点：

- 明 / 暗两套主题下的对比度与层级（组头应像「工作区」那样是分区标题，而不是一条项目行）
- 中 / 英两种语言（chip 文案走 `document.documentElement.lang`）
- 窗口变窄时 chip 截断是否合理
- **其它真实项目的组头没有被误伤** —— 选择器只按 workspace id 命中，这是最该回归的一条
- **组头标题必须仍然可见** —— 隐藏的应是前两个 `span`（图标与箭头），第三个才是文字

### 3.4 设置卡（`plugins.bundle.config`）

这一处是 Slot，但 inspect 只能证明「注册了」，证明不了「填了路径能存进去」。免页面能做的：

- `Slots.listSubTree` 看 key 是否在册（§3.2）。
- `node tests/host.test.js` 里 `the config route reports the effective root and saves a new one once` 覆盖了 GET / POST / 方法限制 / 鉴权 / 清空 / 无编辑器拒绝。

需要页面的：输入框可用性、浏览按钮是否唤起系统选择器、保存后的成功文案、保存触发插件重启时界面是否卡住。

## 4. 页面控制：能做到什么，做不到什么

「控制页面」有两层意思：

1. **我驱动页面**：chrome-devtools MCP（`click` / `fill` / `take_screenshot` / `list_console_messages` / `list_network_requests`）、browser-use MCP（每 Session 一个隔离 Chromium）。
2. **插件驱动页面**：`ctx.layout.selectPanel()`、`ctx.slots.register` / `ctx.slots.inject`、`ctx.theme.setTheme()`、`ctx.workspaces.*`、`ctx.sessions.*`。UI 插件真正该用的是这一层，而不是让人去点。

边界（本机实测）：

- GUI 端口 `127.0.0.1:55067` 裸访问是 `401`，页面显示 `dsh web authentication required; reopen the URL printed by dsh web.`
- MCP 驱动的 Chrome 是**另一个实例**（当时只有 `about:blank`），不共享那个已认证标签页的会话
- browser-use 当时没有活跃 session

所以像素级验证需要**那个已认证的标签页**。拿不到时，只能停在 inspect 层，然后在结论里写清「视觉未验证」。

明确不做的事：搜认证 token、改 `HOME`、翻个人浏览器 profile、改 keychain、做 mock 页面或自渲染截图。**截一张假页面的图不算验证**，宁可说没验。

## 5. 没有页面时的替代验证

按这个顺序做，全都免页面：

```bash
node --check lib/index.js
node --check lib/client.js
node tests/host.test.js         # 11 项：命名/并发/重试/鉴权/Config 契约/路径解析/保存
node tests/client.test.js       # 8 项：共享准备/重试/hot reload/路径误判/新目录/accept 透传
```

> 本机沙箱下 `npm test`（`node --test` 需要 spawn 子进程 + piped stdio）会以 `spawn EPERM` 失败，这是沙箱边界不是用例失败；逐文件直接跑即可。

再加：

- `package.json` 与 `cordis.patch.yml` 能被解析、`dsh.bundle.patch` 指向存在的文件
- Client 查询确认 slot 注册（§3.2）
- Host 路由状态码确认（§2.3）

`tests/` 里已经覆盖了最难用肉眼查的几件事：并发下只分配一个目录、失败后能重试、鉴权/方法/未就绪/真实项目四种拒绝、hot reload 不留悬挂 wrapper、`.../Documents/dsh` 结尾的真实项目不被误判成无项目会话、配置根替换后旧默认路径不再算草稿。

## 6. 开发循环

```text
改 lib/  →  node --check  →  node tests/*.test.js  →  安装/刷新 bundle  →  inspect  →  看页面  →  修
```

- 只动 Host：`install_bundle` 之后 `application: applied` 即可生效。
- 动 Client：客户端 bundle 需要重新构建并被页面加载。免刷新的热更新只在 `pnpm run dev:web` 同时跑着时成立；否则必须重新构建 + 刷新页面，刷新后重新查一次 §3.2 的 occupants。
- 改完先看 console 有没有 slot entry 崩溃，再看视觉。

## 7. 验证记录

### 7.1 代码层（2026-11-17，可复现）

本机实测、免页面的部分：

| 项 | 结果 |
| --- | --- |
| `node --check lib/index.js` / `lib/client.js` | 通过 |
| `node tests/host.test.js` | 11 项通过（含 Config 契约、路径解析、保存与拒绝） |
| `node tests/client.test.js` | 8 项通过（含新目录生效、旧目录不再算草稿、`accept` 透传） |
| 修复前 `conversation.hero.workspace` | **只有 `priority: 0, active: true` 一条** → 本插件菜单未挂上（即 `getAnchorRect` 破坏的实测证据） |

### 7.2 装机层（2026-11-17 实测）

本机 DSH `0.2.2-rc.3` Desktop，profile `desktop`，`install_bundle` 装的是本地目录（`link:D:/Developer/dsh-plug/dsh-no-project-sessions`，v0.3.0）。

| 项 | 怎么查 | 实测结果 |
| --- | --- | --- |
| 安装生效 | `install_bundle` 返回值 | `application: applied`，`version: 0.3.0`，`warnings: []` |
| Config 投影 | `host/Config` `listConfigs` `name=dsh-no-project-sessions` | 1 条 entry，**`status: "schema"`** |
| Config 字段 | 同上，带 `entry` | schema 含 `scratchRoot`（string，default `""`），`acceptsMissing: true` |
| 菜单 shim | `client/Slots` `conversation.hero.workspace` | **两条 occupant**：`-1 active:true` / `0 active:false` |
| 设置卡 | `client/Slots` `plugins.bundle.config` | `key: dsh-no-project-sessions`，`active: true` |
| 路由存在 + 鉴权 | 裸访问 GUI 端口 | `GET/POST/DELETE /dsh-no-project/config` → `401`；`POST /dsh-no-project/prepare` → `401`；未注册路由 → `405` |

**踩到的坑（值得记）：** 第一次装完 Config 报 `status: "unsupported"`。原因是 `Config` 用了手写的 standard-schema 对象——它能过 cordis 的 `Config['~standard'].validate`，但 DSH 的 Config 投影只认**原生 Schemastery 图**（`isNativeConfigSchema` 检查 `Symbol.for('schemastery')`、字符串 `type`、对象 `meta` 三者）。`unsupported` 会让插件页的配置卡**完全不渲染**。改成 `z.object({ scratchRoot: z.string().default('') })` 后立刻变 `schema`。

**未验证项：** 视觉部分（设置卡的输入框 / 浏览按钮 / 保存反馈、侧栏组头样式、Hero chip 文案、明暗主题对比度）还没在真实已认证页面上逐项确认。

### 7.3 真实写入（2026-11-17 实测）

设置卡里的"保存"最终调用 `configEditor.edit`，把值写进 profile 的 `cordis.patch.yml`。这一步在本机实测过一次：

| 项 | 结果 |
| --- | --- |
| 目标 | `D:\dsh-sessions`（用户指定） |
| `resolveScratchRoot` 归一化 | `D:\dsh-sessions`（尾部斜杠被去掉） |
| 写入的 row config | `{"scratchRoot":"D:\\dsh-sessions"}` |
| 写入位置 | `~/.dsh/profiles/desktop/cordis.patch.yml`，以 `- id: no-project-sessions` 的整行 config 形式追加 |
| YAML 回读 | 解析通过，9 条 entry，该行 `config.scratchRoot` 正确 |
| 行状态 | `include:no-project-sessions` → `enabled: true, fiberPhase: active` |
| Config 投影 | `status: "schema"`（含 `scratchRoot`） |

**注意：** 这次写入是**直接改 profile patch 文件**做的（等价于 `configEditor.edit` 的产物，但绕过了 UI 与鉴权路由），用于验证"值能落盘并被 Host 读回"。**通过插件页 UI 点保存**这条路径仍未在真实页面上走过——鉴权路由对未认证请求返回 `401` 的实测已确认，但"带 cookie 的浏览器点保存 → 值写入"没有端到端跑过。

**未验证项：** 侧栏是否出现指向 `D:\dsh-sessions` 的「最近」分区（需要刷新页面目视确认）；视觉部分的其余项（见 §7.2 末）。

### 7.4 升版回归清单（0.2.2-rc.3）

这几条是本次实测确认过的宿主接口变化，每次升版都该重跑：

1. **`Menu` 定位**：宿主已移除 `getAnchorRect`，改为 `anchorRef` / `anchorPoint`（`v0.2.2-alpha.2/css-anchored-menus`）。本插件已不再 `require` 宿主 primitives，改为自绘菜单，因此这条不再随宿主 props 变动而崩。
2. **`conversation.sendSession` 签名**：现为 `(session, text, attachmentIds, mode, signal, accept)`；本插件包装器必须透传第 6 个参数，否则发送态不结算。
3. **`workingDirectory` 投影**：已是 summary-excluded（`v0.2.2-alpha.2/projection-snapshot-scope`），要从打开的 Session 的 `binding.session.projections` 读，不能只读 list 行的 `projectionValues`。
4. **侧栏组头 DOM**：`[data-row-key="workspace:<id>"]` 内前两个 `span` 才是图标与箭头，第三个是文字；按 `span:first-child` 隐藏会连标题一起藏掉。
5. **主题 token**：`--dsw-alias-label-tertiary` 已不在 `Theme.listTokens` 的公开列表里，改用 `--dsw-alias-label-secondary`；`--dsh-workspace-indent` 仍是宿主自产变量。
6. **`Config` 必须是原生 Schemastery 图**：DSH 的 `Config.listConfigs` 用 `isNativeConfigSchema` 判定（检查 `Symbol.for('schemastery')` 标记、字符串 `type`、对象 `meta`）。手写的 standard-schema 对象虽然能过 cordis 激活时的 `Config['~standard'].validate`，但会被报成 `status: "unsupported"`，**插件页的配置卡完全不渲染**。主机端表单相关行为变了就重新确认这条。

## 8. 报告模板

给结论时按这三段写，别把「已注册」说成「已看到」：

1. **已证明**：安装 `applied` + 哪条 inspect / 哪个状态码。
2. **未证明**：视觉项、需要人工点的交互项。
3. **回归风险**：宿主 token 名、workspace 行 DOM 结构（`data-row-key`、`heroWorkspaceRow`）、`conversation.sendSession` 签名、`plugins.bundle.config` 的 key 约定。
