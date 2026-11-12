---
description: "在 DeepSeek Harness 中收集灵感、直接编辑 Wiki Notes 作品、继续原生会话、生成脚本与图片并安排发布。"
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

[English](README.md) | 中文

## 概要

通过 DSH 侧栏工作台收集灵感、直接编辑 Wiki Notes 中已登记的作品 Markdown、生成脚本与分镜并安排发布日历。每篇作品和全局助手都可使用持续的 DSH 原生会话与 Media Desk 创作 preset。生图使用单独的服务或兼容的已注册工具。发布仍由用户手动完成。

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

从侧栏打开「自媒体工作台」。安装包包含 Host 入口和浏览器产物。上游 npm 包与本 fork 共用面板 ID、路由和数据；同一个 profile 只启用其中一个。工作台状态和设置保存在 `<DSH_HOME>/media-desk/`，默认 home 为 `~/.dsh`；已登记的作品文字位于 Wiki Notes。[上游使用指南](GUIDE.md)（[中文](GUIDE.zh.md)）说明五个视图、设置、账号导入和文件导出；其中的上游安装命令不会选择本 fork。

<a id="native-conversations"></a>
### 原生会话

使用工作台顶栏的**全局原生会话**，或作品成稿页顶栏的**原生会话**。每个入口都打开 DSH 的普通 Session 页面，提供原生输入、模型选择、工具历史、问答和批准。新作品 Session 使用作品标题；全局 Session 使用独立的助手标题。原生重命名会保留。关闭工作台或重启 DSH 后仍保留关联的 Session，可以从工作台或原生工作区树重新打开。

新关联使用现有的 `WIKI_PATH` 目录，未设置时使用 `~/wiki`。Host 配置 `wikiPath` 覆盖该选择。Wiki 同时确定工作区和 `<Wiki>/notes` 根目录；已登记作品的首个 Session 也沿用作品保存的 Wiki。环境变化后，作品和 Session 保留各自保存的根目录，包括使用符号链接的 Notes 目录。缺失的已保存 Wiki 不会被重建。修改原生工作区或 preset 后，需要恢复绑定的 Wiki 和 Media Desk preset，才能再次从工作台打开。

原生 Session 选定的模型控制该会话。工作台模型选择器仅为新原生关联提供初始选择。缺少原生服务、preset 或 Wiki 时会明确失败；现有关联保留供检查。继续现有会话时，保持相同的 DSH home 并恢复所需的 profile 组件。

<a id="notes-work-files"></a>
### Notes 作品文件

新作品使用 `notes/works/<work-id>-<language>.md`，未知语言记为 `und`。「正文」格子直接读取和编辑已登记的 Markdown，尚未成稿时也可使用。点击「直接修改」，再点击「保存」；格子显示相对文件位置和内容版本。保存草稿或接受成稿文字时，选择其作为同一份当前正文。不同的原始来源文字保留在 `notes/materials`，非当前草稿与固定 AI 原稿使用 `notes/history/<work-id>/`。Store 保存引用和结构化成稿元数据。

已有作品可点击「登记作品文件」，明确选择相对其 Notes 目录的 `works/*.md` 路径。已保存 Session 的 Wiki 优先于当前默认目录。文件头须使用表单显示的作品身份及所声明的语言：

```markdown
---
format: 1
kind: work
id: <work-id>
title: A work
createdAt: 2026-11-01T12:00:00Z
updatedAt: 2026-11-04T12:00:00Z
language: en
tags: []
sources: []
---

Editable Markdown body.
```

只有已登记的作品文件才由工作台管理。`notes/index.md` 接收此数据目录的导航块，保留无关正文、链接和笔记。修改标题不重命名文件。读取、编辑和模型文字接受前都会核对外部字节变化，即使 mtime 未变。打开的作品自动刷新。过期保存保留编辑框中的草稿；「取消修改并重新读取」返回最新文件。文件缺失、改名或无效时显示修复状态。「重新关联作品文件」只接受已拥有 Notes 的 `works` 目录中的普通文件，且作品身份和语言须相同；不会重建正文。

每个 Host 在初始化 Store、Settings 或 Notes 前，协作锁定规范化的数据目录及所有已保存或选中的 Notes 根目录。共享任一目录的另一个 Host 保持不可用且不初始化内容，其他插件仍可使用。正常停用插件时，先取消所属工作，等待写入和外部清理完成，再释放所有权。使用此布局前须停止旧版本，它们不参与这些锁。

点击工作台顶部的「恢复保存与迁移」，在备份验证后将旧作品及各语言版本迁入 Notes。「作品语言」选择器在保留的版本之间切换。保存失败会保留候选；重试返回原接受回执，不重新生成。冲突核对可保留当前正文或采用保留的外部版本。撤销还原所属编辑并保留后来的不重叠修改。迁移、修复和离线回滚见 [Notes 恢复](GUIDE.md#notes-recovery)（[中文](GUIDE.zh.md#notes-recovery)）。

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

[Notes 存储测试](test/notes-storage.test.js)覆盖公开读取、编辑、登记、修复和已保存根目录绑定。[恢复](test/notes-recovery.test.js)、[撤销](test/notes-undo.test.js)和[迁移](test/notes-migration.test.js)通过公开 Host 检查保留的文件与回执。[所有权测试](test/write-ownership.test.js)使用独立进程和暂停的公开 Store 操作，检查竞争、写入排空及被终止持有者的恢复。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[组合补丁](cordis.patch.yml)激活包的 Host 和专用创作 preset。[Host](src/host.js)鉴权 `/media-desk` 请求，通过[目录所有权](src/write-owner.js)串行执行编辑。[Notes](src/notes.js)在 [Store](src/store.js) 读取时投影已登记 Markdown，并从持久化的已登记作品行中去掉当前和历史文字副本。[原生关联](src/native-sessions.js)保存控制器实际身份、Wiki／Notes 根目录、DSH home、preset 和初始模型。DSH 的 SessionController 管理运行中的 Agent；页面导航只改变客户端订阅。[浏览器入口](client/index.jsx)注册侧栏面板并打开已保存 Session。[Producer](src/produce.js)保留结构化策划案，通过同一份登记正文接受文字。

[保存记录](src/notes-writes.js)在发布前保留独立候选、已接受原版本及移出的编辑器文件。一次 Store 替换接受引用、回执及关联结构化数据，随后发送通知。[逆向编辑](src/notes-undo.js)使用固定的前后版本；[迁移](src/notes-migration.js)验证备份，并在 Wiki 外保留回滚证据。

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

助手接收操作指令、选中内容、精简工作台快照，以及该内容最多八条近期对话。快照从 Notes 读取已登记作品文字。成稿调用通过[提示词](src/ai.js)接收当前作品、风格、启用规则和共用策划案。回复使用 `reply`、`ops`、`actions` 与可选的 `revise`，编辑由 Host 校验，并拒绝过期的登记文字版本。生图工具接收图片提示词，不接收工作台聊天历史。

#### Token 影响

每次请求重新发送所选上下文。较长的文章、风格样文、规则和修改会增加输入 Token；成稿分别调用策划与写作模型，图片请求使用所配置的后端。

#### KV Cache 影响

插件不管理 KV Cache。提供方可能复用重复提示词前缀，内容、日期、规则或模型选择变化可能减少前缀复用；不保证缓存命中。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 兼容范围固定为完整的 DSH `0.2.2-rc.1` Web profile。排期不向平台发布，整体成稿完成时仍可能存在失败图片，Host 中断的任务需要重新成稿。使用同一 DSH home 的 profile 共享工作台数据和关联。
- 原生会话与工作台内嵌助手各有独立历史。内嵌助手、成稿和风格提炼仍直接调用模型。语法、构建检查和受控模型 fixture 不证明真实模型或账号服务行为。
- 中断或失败的原生创建保留待建立状态。通过 `/media-desk/sessions` 或 `<DSH_HOME>/media-desk/sessions.json` 检查错误及已取得的实际 Session ID。不提供自动替代会话或待建立状态恢复。
- 作品迁移保留旧文字、草稿、固定 AI 原稿和已保存语言。设置、可复用偏好、指标和媒体沿用各自现有存储。重叠的逆向编辑需要先修复冲突；撤销失败保留记录。任务候选须通过所属任务校验，重试保存才可接受。
- 协作锁仅覆盖同机本地 Host，普通编辑器不参与。保留的编辑器句柄可在接受后继续修改移出的文件；后续读取保留双方版本并报告冲突。Notes 发布与 Store 接受分步执行，使用恢复日志，不构成文件系统事务。DSH 可在五秒关闭超时后强制退出，即使启动器退出码为零，成稿也可能仍处于中断状态。

### 开发备注

无。
