# dsh-no-project-sessions

DeepSeek Harness 插件：让"不在项目中工作"的会话从创建那一刻起就住进自己的独立目录。

## 功能

- **无项目会话**：把空白会话的项目下拉菜单替换为带「不在项目中工作」选项的版本，不必先选项目。
- **可配置的默认对话目录**：在插件页设置一次草稿根目录（默认 `~/Documents/dsh`）。保存后插件重启，不需要重启整个应用。
- **全部归到「最近」**：只注册一个名为「最近」的工作区，所有无项目会话都归属它，在侧栏里依次排列。
- **每个会话一个独立目录**：首条消息发出前，会话的**工作目录**被提交到 `<根>/<YYYY-MM-DD>/<目录名>`，名字取自首条消息里的英文。
- **开头会有一条上下文**：因为工作目录确实变了，DSH 会在第 1 轮第 1 步注入一条 `The working directory changed from … to …`，让模型知道自己在哪个目录。
- **无侵入**：只用 Harness 的 workspace、slot 与主题 token，不替换宿主组件，也不改写其它插件的 DOM。

## 目录与侧栏

```
D:\dsh-sessions/              ← 工作区「最近」
├── 2026-11-17/
│   ├── hello-world/          ← 首条消息 "hello world"
│   ├── hello-world-2/        ← 另一会话也发了同样内容
│   └── new-chat/             ← 纯中文消息提不出英文，回退
└── 2026-11-18/
    └── fix-the-login-bug/
```

侧栏：

```
最近
├── Greeting                  ← 会话按顺序排列
└── 搜索今天的 OpenAI 新闻
```

两个概念要分开：

| | 值 | 谁维护 |
| --- | --- | --- |
| 会话归属（`header.cwd`） | `<根>`，所以归「最近」 | DSH，创建后不可改 |
| 会话工作目录（`workingDirectory`） | `<根>/<日期>/<消息派生名>` | 本插件，首条消息时提交 |

归属留在根，会话才会全在「最近」里；DSH 判定归属用 `candidateMatches` 的**精确路径相等**，把 header 挪到子目录会让会话掉出该分组。工作目录才是每会话独立的那一层。

## 环境

- DeepSeek Harness 0.2.2-rc.1 及以上（Desktop / Web），`package.json` 的 `engines.dsh` 声明了范围。
- Host 半依赖 `@deepseek-ai/schemastery`（DSH 自带，已声明为 peer dependency）。`Config` **必须**是原生 Schemastery 图：DSH 的 `Config.listConfigs` 只认这种，手写的 standard-schema 会被判为 `unsupported`，插件页的配置卡就不会渲染。
- 插件同时包含 Host 与 Client 两半：
  - Host：`POST /dsh-no-project/prepare`（为该会话分配 `<root>/<date>/<n>` 并提交为工作目录）与 `/dsh-no-project/config`（读写草稿根、返回「最近」工作区 id）。
  - Client：替换项目下拉菜单（加入「不在项目中工作」），在发送前触发目录准备，并在插件页提供「默认对话目录」设置卡。

## 目录名怎么来

取首条消息里的前 6 段 ASCII 字母/数字，转小写、用连字符连接、截到 80 字符；重名时追加 `-2`、`-3`。

| 首条消息 | 目录名 |
| --- | --- |
| `hello world` | `hello-world` |
| `Fix the login bug in auth.js` | `fix-the-login-bug-in-auth` |
| `帮我修一下这个 bug` | `bug` |
| `帮我看看这个`（纯中文） | `new-chat` |

也可以不用界面，直接在该插件的 `config` 里写：

```yaml
- insert:
    - id: no-project-sessions
      name: 'dsh-no-project-sessions'
      config:
        scratchRoot: 'C:\Notes'   # 留空则用 <home>/Documents/dsh
```

## 安装

将本仓库克隆到本地：

```bash
git clone git@github.com:GoetheDady/dsh-no-project-sessions.git
```

然后在 DeepSeek Harness 的插件管理器中安装这个本地包目录（包含 `package.json` 与 `cordis.patch.yml`），或在 profile 的 `dsh.profile.bundles` 中引用它。

> 升级已装版本时**先移除再安装**：HMR 下直接重装同名包会以 `already-installed` 失败。
> 跑单测需要在仓库根有 `schemastery` 可解析（例如把 profile 里的 `node_modules/@deepseek-ai/schemastery` 链到本地 `node_modules/`）；运行时它从 dsh 安装位置解析，不需要这一步。

## 设置默认对话目录

装好之后打开 **插件** → **无项目会话**（卡片名即包名 `dsh-no-project-sessions`），页面上的「默认对话目录」卡片就是设置入口：

1. 直接输入绝对路径，或点「浏览…」用系统目录选择器挑一个。
2. 点「保存」。插件会把该值写入 profile 里本行的 `config.scratchRoot`，然后重启自己。

保存后新建的无项目会话都落在新目录下。留空并保存表示恢复内置默认值 `~/Documents/dsh`。

> 这个值只在插件页设置，不提供运行时随时切换的入口：改一次即长期生效。
> 已经建在旧目录下的历史会话不会被迁移。0.4.0 起还会注销旧版遗留的「最近」聚合工作区（只删注册，目录与会话日志保留）。

也可以不用界面，直接在该插件的 `config` 里写：

```yaml
- insert:
    - id: no-project-sessions
      name: 'dsh-no-project-sessions'
      config:
        scratchRoot: 'C:\Notes'   # 留空则用 <home>/Documents/dsh
```

## 开发

```bash
node --check lib/index.js
node --check lib/client.js
node tests/host.test.js      # 16 项
node tests/client.test.js    # 9 项
```

> 本机沙箱下 `npm test`（`node --test` 需 spawn 子进程）会以 `spawn EPERM` 失败，这是沙箱边界；逐文件直接跑即可。

## 验证

插件装好之后怎么确认它真的在跑、页面在哪看、哪些东西验证不了，见 [docs/verification.md](docs/verification.md)。要点：

- 三层通道：安装返回值 → Host inspect → Client inspect（会转发进真实页面作答）。
- 用能力证明，不用截图证明：路由的 `401` / `405`、Slot occupant 的 `active` 才是证据。
- `Config.listConfigs` 的 `status` **不是**活性；没有已认证标签页时，报告里必须写清「视觉未验证」。

## 目录

```text
lib/index.js        Host half：目录分配 + 工作区注册、草稿根读写路由
lib/client.js       Client half：项目下拉增强、默认目录设置卡
locale/*.json       插件标题与描述
cordis.patch.yml    Bundle 入口（含默认 config）
tests/              Node 内置测试
docs/               验证方法与实测记录
```
