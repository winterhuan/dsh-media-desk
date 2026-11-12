---
description: "在 DeepSeek Harness 中收集灵感、通过原生会话查询 Wiki、生成脚本与图片并安排发布。"
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

[English](README.md) | 中文

## 概要

通过 DSH 侧栏工作台收集灵感、生成脚本与分镜、安排发布日历并复用写作规则。为每篇作品和独立的全局助手打开持续的 DSH 原生会话，使用现有 Wiki 和 Media Desk 创作 preset。生图使用单独的服务或兼容的已注册工具。发布仍由用户手动完成。

## 目录

- [使用此包](#use-this-package)
- [开发](#development)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在已构建的源码检出中，安装到独立的 DSH `0.2.2-rc.1` Web profile，再打开 DSH 输出的地址：

```sh
dsh --profile media-desk-dev --from-default-profile web --dump-config
dsh plugin --profile media-desk-dev add "link:$PWD"
dsh --profile media-desk-dev --port 0 --no-open
```

从侧栏打开「自媒体工作台」。安装包包含 Host 入口和浏览器产物。上游 npm 包与本 fork 共用面板 ID、路由和数据；同一个 profile 只启用其中一个。内容保存在 `<DSH_HOME>/media-desk/`，默认 home 为 `~/.dsh`。[上游使用指南](GUIDE.md)（[中文](GUIDE.zh.md)）说明五个视图、设置、账号导入和文件导出；其中的上游安装命令不会选择本 fork。

<a id="native-conversations"></a>
### 原生会话

使用工作台顶栏的**全局原生会话**，或作品成稿页顶栏的**原生会话**。每个入口都打开 DSH 的普通 Session 页面，提供原生输入、模型选择、工具历史、问答和批准。新作品 Session 使用作品标题；全局 Session 使用独立的助手标题。原生重命名会保留。关闭工作台或重启 DSH 后仍保留关联的 Session，可以从工作台或原生工作区树重新打开。

新关联使用现有的 `WIKI_PATH` 目录，未设置时使用 `~/wiki`。Host 配置 `wikiPath` 覆盖该选择。解析后的 Wiki 同时确定工作区和 `<Wiki>/notes` 根目录；缺失的 Wiki 不会被创建。已保存的关联在环境变化后仍保留原目录。修改原生工作区或 preset 后，需要恢复绑定的 Wiki 和 Media Desk preset，才能再次从工作台打开。

原生 Session 选定的模型控制该会话。工作台模型选择器仅为新原生关联提供初始选择。缺少原生服务、preset 或 Wiki 时会明确失败；现有关联保留供检查。继续现有会话时，保持相同的 DSH home 并恢复所需的 profile 组件。

<a id="development"></a>
## 开发

在父仓库的 `plugins/dsh-media-desk` 修改源码。使用冻结的 pnpm 锁文件安装依赖，检查语法、构建浏览器入口并运行 Host 测试：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
```

上游源码使用 JavaScript。`typecheck` 检查 `src`、`scripts` 和 `test` 中的 JavaScript 语法，构建解析浏览器 JSX；这些命令不提供静态类型检查。构建产物 `dist/client.js` 随 Git 提交，使远程安装无需生命周期构建；浏览器源码变化后必须重新生成。保留 npm 锁文件供上游工作流使用，父仓库使用 pnpm。

[原生运行时 fixture](test/fixtures/native-runtime.js)安装隔离的官方 Web profile，在临时 Wiki 上运行真实的 Loader、SessionController 和工具。模型适配器仅控制外部模型响应。[技能指令记录](test/fixtures/llm-wiki.instructions.json)标识固定的 `llm-wiki` 指令文件；不包含个人 Wiki 页面。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[组合补丁](cordis.patch.yml)激活包的 Host 和专用创作 preset。[Host](src/host.js)鉴权 `/media-desk` 请求，在发布供原生冷恢复使用的服务前初始化唯一的内容 Store。[原生关联](src/native-sessions.js)持久化公开控制器实际返回的身份，以及 DSH home、preset 和初始模型。DSH 的 SessionController 管理运行中的 Agent；页面导航只改变客户端订阅。[浏览器入口](client/index.jsx)注册侧栏面板并打开这些已保存的 Session。[Producer](src/produce.js)和 [Store](src/store.js)保留工作台的生产流程及 JSON、媒体持久化路径。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [上游项目](https://github.com/woniuniuniu/dsh-media-desk)与[使用指南](GUIDE.md)（[中文](GUIDE.zh.md)）。
- [DSH Creative 交接](https://github.com/winterhuan/dsh-creative/blob/develop/HANDOFF.md)说明子模块归属和 profile 操作。
- [MIT 许可](LICENSE)，包含上游版权声明。

<a id="model-experience"></a>
## 模型体验

### 原生创作上下文

#### 模型看到什么

原生会话通过[创作上下文](src/native-context.js)接收创作 persona、绑定的作品或全局身份及 Wiki 路径、本地指令、当前时间和普通 Session 历史。preset 提供文件、搜索、Shell、技能、网页、问答、批准和压缩能力。实际生效的 `llm-wiki` 技能读取选中的页面与带日期的来源，不注入整个 Wiki。主题综合提供事实；只有选中的作者样文提供个人文风。此 preset 不包含编码、插件管理、定时、目标和委派工作流。

#### Token 影响

普通 Session 历史、加载的技能指令和选中文件内容会增加输入 Token。Wiki 研究加载相关查询指令与命中页面，不读取所有页面。

#### KV Cache 影响

原生会话使用 DSH 的模型适配器和缓存行为。Media Desk 不增加缓存配置，也不保证命中。

### 工作台上下文

#### 模型看到什么

助手接收操作指令、选中内容、精简工作台快照，以及该内容最多八条近期对话。成稿调用通过[提示词](src/ai.js)接收灵感、风格、启用规则和共用策划案。回复使用 `reply`、`ops`、`actions` 与可选的 `revise`，编辑由 Host 校验。生图工具接收图片提示词，不接收工作台聊天历史。

#### Token 影响

每次请求重新发送所选上下文。较长的文章、风格样文、规则和修改会增加输入 Token；成稿分别调用策划与写作模型，图片请求使用所配置的后端。

#### KV Cache 影响

插件不管理 KV Cache。提供方可能复用重复提示词前缀，内容、日期、规则或模型选择变化可能减少前缀复用；不保证缓存命中。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 兼容范围固定为完整的 DSH `0.2.2-rc.1` Web profile。排期不向平台发布，整体成稿完成时仍可能存在失败图片，Host 中断的任务需要重新成稿。使用同一 DSH home 的 profile 共享工作台数据和关联。
- 原生会话与工作台内嵌助手各有独立历史。内嵌助手、成稿和风格提炼仍直接调用模型。语法、构建检查和受控模型 fixture 不证明真实模型或账号服务行为。
- 中断或失败的原生创建保留待建立状态。通过 `/media-desk/sessions` 或 `<DSH_HOME>/media-desk/sessions.json` 检查错误及已取得的实际 Session ID。不提供自动替代会话或待建立状态恢复。

### 开发备注

无。
