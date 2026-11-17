# 在 dsh 中验证插件

这份文档记录 **dsh-no-project-sessions** 的验证方法：装完之后怎么确认它真的在跑、页面在哪看、哪些东西验证不了。

原则只有一条：**用能力证明，不用截图证明。**

## 1. 插件做什么

只注册**一个**名为「最近」的工作区，路径是草稿根。所有无项目会话的 `header.cwd` 都等于草稿根，因此全部归属这一个分组，在侧栏里依次排列。

首条消息发出前，客户端调用 `POST /dsh-no-project/prepare`，Host 在 `<根>/<YYYY-MM-DD>/<目录名>` 建目录并把该会话的**工作目录**提交到那里（目录名取自首条消息里的英文）。会话归属不变，工作目录变成自己的独立目录。这个提交会让 DSH 注入一条 `The working directory changed from … to …` 上下文。

两个字段要分清：

| | 值 | 谁维护 | 可变性 |
| --- | --- | --- | --- |
| 归属 `header.cwd` | `<根>` | DSH | 创建后只读 |
| 工作目录 `workingDirectory` | `<根>/<日期>/<消息派生名>` | 本插件 | 可提交变更 |

DSH 判定归属用 `candidateMatches` 的**精确路径相等**，所以 header 一旦挪到子目录，会话就会掉出「最近」。

## 2. 三层通道

| 层 | 手段 | 能证明什么 | 是否需要批准 |
| --- | --- | --- | --- |
| 安装 | `plugin_manager` 的 `install_bundle` 返回值 | 变更是否**已生效**：只看 `application` 与 `warnings` | 可能需要 |
| Host | `cordis_inspect_query` `platform: host` | row 在不在 loader、Config 投影成什么、Host 服务签名 | 免批准（只读） |
| Client | `cordis_inspect_query` `platform: client` | 页面里**真的注册了**什么：Slot、occupants、theme token | 免批准（只读） |

Client 查询会**转发进真实页面、由页面作答**。这是唯一能证明「UI 真的挂上去了」的免批准通道。

安装是否成功，只有 `application: applied` 算证据。

## 3. 判定规则（踩过的坑）

### 3.1 `Config` 必须是原生 Schemastery 图

DSH 的 `Config.listConfigs` 用 `isNativeConfigSchema` 判定，检查三样：`Symbol.for('schemastery')` 标记、字符串 `type`、对象 `meta`。

手写的 standard-schema 对象**能过** cordis 激活时的 `Config['~standard'].validate`，但会被 DSH 报成 `status: "unsupported"`，结果是**插件页的配置卡完全不渲染**。

所以 `lib/index.js` 里必须是 `z.object({...})`，且 `@deepseek-ai/schemastery` 声明为 peer dependency。

### 3.2 `Config.listConfigs` 的 `status` 要区分 `schema` / `unsupported`

| status | 含义 |
| --- | --- |
| `schema` | 正常，配置卡会渲染 |
| `unsupported` | Config 不是原生 Schemastery 图，配置卡**不渲染** |
| `absent` | 插件没声明 Config |
| `inactive` | 行被禁用或 fiber 未加载 |

### 3.3 判断 Host 路由是否存在：比状态码，不比 200

对着 GUI 端口裸访问（无认证）：

```text
GET  /                                  → 401   鉴权闸门
POST /dsh-no-project/prepare            → 401   路由存在，requestRejection 拒绝
GET  /dsh-no-project/config             → 401   同上
POST /definitely-not-a-route            → 405   未注册路由的兜底
```

`401` 与 `405` 的差别就足以证明「路由注册了，鉴权也生效了」，不需要任何 token。

## 4. 检查清单

### 4.1 Host 半

| 检查 | 怎么查 | 期望 |
| --- | --- | --- |
| Bundle 在组合里 | `list_bundles` / profile 的 `dsh.profile.bundles` | 有 `dsh-no-project-sessions` |
| Config 投影 | `host/Config` `listConfigs` `name=dsh-no-project-sessions` | `status: "schema"` |
| 路由注册 + 鉴权 | §3.3 | `401` |
| 目录准备 | 带认证调用 `POST /dsh-no-project/prepare` `{sessionId, text}` | 返回 `{ path }`，形如 `<root>/<YYYY-MM-DD>/<slug>`；同会话再调返回 `reused: true` |
| 分组工作区 | `~/.dsh/storages/workspace.json` | **恰好一个** title 为 `最近`、path 等于草稿根的条目 |
| 无每会话工作区 | 同上 | 不应出现 `2026-11-17 1` 这类为单个会话注册的工作区 |
| 并发只建一个 | `node tests/host.test.js` 的并发用例 | 5 个并发准备只提交一次、只建一个目录 |
| 旧根已注销 | 同上 `workspace.json` | 只有**当前**草稿根有一个 `最近` |

### 4.2 Client 半

```jsonc
{ "platform": "client", "provider": "Slots", "method": "listSubTree",
  "input": { "root": "conversation.hero.workspace" } }
```

期望 occupants 两条：

- `priority: -1, active: true` —— 我们的菜单，**正在生效**
- `priority: 0, active: false` —— 宿主的原版，被压住

设置卡：

```jsonc
{ "platform": "client", "provider": "Slots", "method": "listSubTree",
  "input": { "root": "plugins.bundle.config" } }
```

期望 occupants 里有 `key: "dsh-no-project-sessions", active: true`。

### 4.3 视觉检查

本插件不再改写宿主 DOM（侧栏组头样式、Hero chip 文案那套已随 0.4.0 移除），所以 inspect 能覆盖的部分更多了。仍需看页面的：

- 项目下拉菜单里**不出现** `<root>` 下的任何目录（插件自己的会话目录被过滤掉了）
- 菜单底部「新建项目」「不在项目中工作」两项的位置与样式
- 明 / 暗两套主题下菜单与设置卡的可读性
- 窗口变窄时菜单不溢出视口

## 5. 没有页面时的替代验证

```bash
node --check lib/index.js
node --check lib/client.js
node tests/host.test.js      # 16 项
node tests/client.test.js    # 9 项
```

> 本机沙箱下 `npm test`（`node --test` 需要 spawn 子进程 + piped stdio）会以 `spawn EPERM` 失败；这是沙箱边界，不是用例失败。逐文件直接跑即可。

`tests/` 覆盖了最难肉眼查的几件事：`Config` 契约、目录命名的原子保留与并发、prepare 的幂等与四种拒绝（鉴权/方法/会话未就绪/真实项目）、旧工作区注销、草稿根解析与保存（含无 `configEditor` 时的拒绝）、不可读根时**不猜**任何目录、发送前准备与 `accept` 透传。

## 6. 开发循环

```text
改 lib/  →  node --check  →  node tests/*.test.js  →  移除+安装 bundle  →  inspect  →  看页面  →  修
```

- 只动 Host：`install_bundle` 之后 `application: applied` 即可生效。
- 动 Client：客户端 bundle 需要页面重新加载。免刷新的热更新只在 `pnpm run dev:web` 同时跑着时成立。
- **打包版 Desktop 没有 `Ctrl+R` / `Ctrl+Shift+R`**：应用菜单里 `role: "reload"` 只在 `!app.isPackaged`（开发模式）时注册，Windows 打包版甚至把菜单替换成只有隐藏的 DevTools 项。要重新加载页面用 `F12` 打开 DevTools 后在里面刷新，或退出重开应用。
- 升级已装版本要先 `remove_bundle` 再 `install_bundle`（HMR 下重装同名包会以 `already-installed` 失败）。

## 7. 验证记录

### 7.1 代码层（2026-11-17，可复现）

| 项 | 结果 |
| --- | --- |
| `node --check` 两个文件 | 通过 |
| `node tests/host.test.js` | 16 项通过 |
| `node tests/client.test.js` | 9 项通过 |

### 7.2 装机层（2026-11-17 实测，v0.4.0）

本机 DSH `0.2.2-rc.3` Desktop，profile `desktop`，`install_bundle` 装本地目录（`link:...`）。

| 项 | 结果 |
| --- | --- |
| 安装 | `application: applied`，`version: 0.4.0`，`warnings: []` |
| Config 投影 | `status: "schema"` |
| 菜单 shim | `conversation.hero.workspace` 两条 occupant：`-1 active:true` / `0 active:false` |
| 设置卡 | `plugins.bundle.config` 含 `key: dsh-no-project-sessions`，`active: true` |
| 路由 | `POST /prepare` → `401`；`GET /config` → `401`；未注册路由 → `405` |
| 「最近」工作区 | `workspace.json` 中恰好一个，path 等于草稿根 |

**未验证项：** 视觉部分（菜单不出现插件自有目录、明暗主题、窄窗口）与「点『不在项目中工作』后真的建出 `<root>/<date>/<slug>` 且会话落在其中」这条端到端流程，都需要在已认证页面里人工走一遍。prepare 的行为目前由单测覆盖，尚未在运行中的 profile 里真实触发过。
