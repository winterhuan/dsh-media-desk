---
description: "在 DeepSeek Harness 中收集灵感、生成脚本与图片、安排发布并复用写作规则。"
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

[English](README.md) | 中文

## 概要

通过 DSH 侧栏工作台收集灵感、生成脚本与分镜、安排发布日历，并把反馈沉淀为写作规则。本 fork 为社区 Media Desk 插件提供 DSH Creative 子模块工作流与固定 Git 安装包。文字使用已配置的 DSH 模型；生图需要单独的图片服务或兼容的已注册工具。发布仍由用户手动完成。

## 目录

- [使用此包](#use-this-package)
- [开发](#development)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

将预构建版本安装到 DSH `0.2.2-rc.1`，然后重启该 profile 并刷新浏览器：

```sh
dsh plugin --profile web add github:winterhuan/dsh-media-desk#v2.6.2-winter.1
```

从侧栏打开「自媒体工作台」。安装包包含 Host 入口和浏览器产物。上游 npm 包与本 fork 共用面板 ID、路由和数据；同一个 profile 只启用其中一个。内容保存在 `<DSH_HOME>/media-desk/`，默认 home 为 `~/.dsh`。[上游使用指南](GUIDE.md)（[中文](GUIDE.zh.md)）说明五个视图、设置、账号导入和文件导出；其中的上游安装命令不会选择本 fork。

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

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[组合补丁](cordis.patch.yml)激活包的 Host。[Host](src/host.js)鉴权 `/media-desk` 请求并管理内容、设置和生产。[浏览器入口](client/index.jsx)注册侧栏面板并轮询生产进度。[Producer](src/produce.js)先完成策划，再并行生成文字和图片；[Store](src/store.js)将内容持久化为 JSON 和媒体文件。助手直接调用 DSH 模型服务并应用结构化编辑，不创建原生 Agent Session。模型访问和生图工具由宿主 profile 提供。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [上游项目](https://github.com/woniuniuniu/dsh-media-desk)与[使用指南](GUIDE.md)（[中文](GUIDE.zh.md)）。
- [DSH Creative 交接](https://github.com/winterhuan/dsh-creative/blob/develop/HANDOFF.md)说明子模块归属和 profile 操作。
- [MIT 许可](LICENSE)，包含上游版权声明。

<a id="model-experience"></a>
## 模型体验

### 工作台上下文

#### 模型看到什么

助手接收操作指令、选中内容、精简工作台快照，以及该内容最多八条近期对话。成稿调用通过[提示词](src/ai.js)接收灵感、风格、启用规则和共用策划案。回复使用 `reply`、`ops`、`actions` 与可选的 `revise`，编辑由 Host 校验。生图工具接收图片提示词，不接收工作台聊天历史。

#### Token 影响

每次请求重新发送所选上下文。较长的文章、风格样文、规则和修改会增加输入 Token；成稿分别调用策划与写作模型，图片请求使用所配置的后端。

#### KV Cache 影响

插件不管理 KV Cache。提供方可能复用重复提示词前缀，内容、日期、规则或模型选择变化可能减少前缀复用；不保证缓存命中。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 兼容版本固定为 DSH `0.2.2-rc.1`。排期不向平台发布，整体成稿完成时仍可能存在失败图片，Host 中断的任务需要重新成稿。使用同一 DSH home 的 profile 共享数据。语法、构建检查和固定测试不证明真实模型或账号服务行为。

### 开发备注

本 fork 保留上游业务行为。后续修改在此仓库维护，并重新生成浏览器产物、发布新的不可变版本。
