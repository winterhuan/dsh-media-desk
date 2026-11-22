---
name: media-desk
description: Collect ideas and sources, research and write articles or spoken scripts, revise works, plan visual assets, schedule publication, review metrics and learn reusable writing rules. Use for a continuing editorial workflow around the user's saved works.
---

# Media Desk

围绕同一件作品，把灵感、研究、成稿、修改、素材、排期和复盘连起来。Agent 直接读取、写入和修改内容文件；`media-desk` CLI 提供登记信息读取与文件校验。

## 从当前作品继续

先确认目标作品、当前正文、来源和已启用偏好。已有作品从当前文件继续，不因缺少会话记忆从头生成；改稿与规则学习再读取对应的固定 AI 原稿。当前对话中的修改总结可直接使用，没有独立总结文件也可比较原稿与当前正文。

## 业务流程

按用户当前任务进入所需环节，不要求每次走完全部流程。

| 环节 | 输入与交付 | 详细流程 |
|---|---|---|
| 收集灵感与材料 | 保留来源、日期、摘录范围，形成可继续研究的选题 | [workbench.md](references/workbench.md) |
| 研究与策划 | 读取写作偏好，核对证据，形成论点、结构和画面要求 | [production.md](references/production.md) |
| 成稿与自检 | 按体裁写正文，逐条检查启用规则，修正后保存文件 | [production.md](references/production.md) |
| 改稿与版本 | 根据反馈直接改当前正文，保留作品身份、来源和固定原稿 | [editing.md](references/editing.md) |
| 图片与分镜 | 将画面要求交给全局 [image-generation](../image-generation/SKILL.md)，检查并关联结果 | [production.md](references/production.md) |
| 排期与发布记录 | 记录平台、时区与发布时间，区分待发布和实际发布 | [review.md](references/review.md) |
| 复盘与规则学习 | 比较原稿、当前稿和反馈，与已有规则去重，保存待审提案 | [learning.md](references/learning.md) |

作者样文提炼和个人文风设置也按 [learning.md](references/learning.md) 执行。文件缺失、冲突或保存中断时读取 [recovery.md](references/recovery.md)。

## 内容与偏好

- 当前正文是可编辑文件；来源材料与固定 AI 原稿保持各自角色。保留已登记身份、语言、frontmatter 和全部仍有效来源，不覆盖固定原稿。
- 研究知识库时使用实际生效的 `llm-wiki` 及该库指令。知识综合提供事实，用户明确选定的作者样文提供文风；保留来源日期和证据范围。
- 开始制作时记录当前语气、选定风格和启用规则。本次制作使用这些版本，交稿前逐条检查适用范围并修正违规；自检是模型报告。
- 修改反馈用于解释修改原因。篇幅、源码参数、commit 和实验数字不自动成为通用偏好；未确认的 review 意见单列。
- 规则提案写明适用范围、修改依据、观察到的改写示例及相近规则，等待用户审阅启用。停用规则不因导出旧写作 skill 而恢复。
- 排期不自动发布。单图失败保留正文和其他素材，结果不明先核对文件，不重复整个付费生成任务。

## 文件操作与交付

需要定位文件、读取登记信息或校验时使用同一 npm 包提供的 `media-desk read/validate`，用法及文件格式见 [runtime.md](references/runtime.md)。Agent 用已有文件工具直接修改，再校验并修复；CLI 不代写、不自动修复、不登记或接受成果。

返回作品身份、当前文件、已完成环节和待审提案。校验通过只说明文件符合规则；尚未登记、缺来源、素材失败或界面未接续的事项分别说明。
