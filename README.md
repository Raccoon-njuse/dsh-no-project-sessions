# dsh-no-project-sessions

DeepSeek Harness 插件：为不属于任何项目的会话自动创建独立工作目录，并在侧栏以「最近」分区集中展示。

## 功能

- **无项目会话**：把空白会话的项目下拉菜单替换为带「不在项目中工作」选项的版本，不必先选项目或工作区。
- **可配置的默认对话目录**：在插件详情页设置一次草稿根目录（默认 `~/Documents/dsh`），此后的无项目会话都建在该目录下。设置保存后插件重启，不需要重启整个应用。
- **自动工作目录**：发送第一条消息时，在 `<草稿根>/<YYYY-MM-DD>/` 下根据消息内容创建可读的目录名；重名时自动追加 `-2`、`-3` 等后缀。
- **侧栏「最近」分区**：使用 Harness 原生 workspace 分组展示这些会话，并将组头样式调整为与「工作区」同级的分区标题。
- **无侵入**：复用 Harness 的 workspace、session、slot 与主题 token，不替换宿主组件，也不改写其它插件的 DOM。

## 环境

- DeepSeek Harness 0.2.2-rc.1 及以上（Desktop / Web），`package.json` 的 `engines.dsh` 声明了范围。
- Host 半依赖 `@deepseek-ai/schemastery`（DSH 自带，已声明为 peer dependency）。`Config` **必须**是原生 Schemastery 图：DSH 的 `Config.listConfigs` 只认这种，手写的 standard-schema 会被判为 `unsupported`，插件页的配置卡就不会渲染。
- 插件同时包含 Host 与 Client 两半：
  - Host：注册 `POST /dsh-no-project/prepare`（原子地预留目录并提交会话工作目录）与 `/dsh-no-project/config`（读写草稿根）。
  - Client：替换项目下拉菜单（加入「不在项目中工作」）、提供「最近」分区标题样式，并在插件详情页提供「默认对话目录」设置卡。

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

保存后新建的无项目会话都落在新目录下的日期子目录里。留空并保存表示恢复内置默认值 `~/Documents/dsh`。

> 这个值只在插件页设置，不提供运行时随时切换的入口：改一次即长期生效，符合「装一次、此后不改」的用法。
> 已经建在旧目录下的历史会话不会被迁移，也不再显示在「最近」分区中——磁盘上的文件保持原样。

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
npm test
node --check lib/client.js
node --check lib/index.js
```

## 验证

插件装好之后怎么确认它真的在跑、页面在哪看、哪些东西验证不了，见 [docs/verification.md](docs/verification.md)。要点：

- 三层通道：安装返回值 → Host inspect → Client inspect（会转发进真实页面作答）。
- 用能力证明，不用截图证明：路由的 `401` / `405`、Slot occupant 的 `active` 才是证据。
- `Config.listConfigs` 的 `status` **不是**活性；没有已认证标签页时，报告里必须写清「视觉未验证」。

## 目录

```text
lib/index.js        Host half：workspace 注册、目录预留、草稿根读写路由
lib/client.js       Client half：项目下拉增强、侧栏「最近」样式、默认目录设置卡
locale/*.json       插件标题与描述
cordis.patch.yml    Bundle 入口（含默认 config）
tests/              Node 内置测试
docs/               验证方法与实测记录
```
