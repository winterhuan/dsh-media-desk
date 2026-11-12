# LLM Wiki Templates

Customize these templates to the wiki's domain. Replace all placeholders and
remove examples that do not apply.

Unless the user or local schema specifies another language, localize all
agent-authored headings, descriptions, summaries, and log entries into
Simplified Chinese. Keep raw sources in their original language.

## `SCHEMA.md`

````markdown
# Wiki Schema

## 领域

[明确说明本 Wiki 覆盖和排除的内容。]

## 语言

- Agent 编写的内容默认使用简体中文。
- Raw 正文保持原始语言且不可改写；必要时可修复 frontmatter 元数据。
- 文件名使用稳定的英文小写 slug。

## 约定

- 文件名使用小写单词，以连字符分隔。
- 每个综合页面都有 YAML frontmatter。
- 综合页面之间使用 `[[wikilinks]]`。
- 新建和实质更新的全局综合页面应包含至少两个有意义的出站链接。
- 内容变化时更新 `updated`。
- 每个全局综合页面都加入根 `index.md`；学习与研究材料通过 `notes/index.md` 导航。
- 知识保存、修订与维护追加到根 `log.md`；材料按主题组织，不管理任务进度或项目状态。
- 重要主张与来源特定段落就近标注证据，不受来源数量限制。
  `^[raw/path/source-file.md]` 必须支持相邻主张，并登记到本页 `sources`。
- 新增或实质修改知识主张时，执行维护 skill 的 factual-verification.md；
  结构检查不代替事实核验。

## Frontmatter

```yaml
---
title: 页面标题
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [已声明标签]
sources: [raw/articles/source-name.md]
# 可选质量信号：
confidence: high | medium | low
contested: true
contradictions: [other-page-slug]
---
```

观点性强、变化快、不确定或只有单一来源的结论使用 `confidence: medium`
或 `low`。只有核心主张得到可靠且独立的证据支持时才使用 `high`；同源转述不算
独立印证，`updated` 不代表全页已复核。

## Raw 来源 Frontmatter

```yaml
---
source_url: https://example.com/article
ingested: YYYY-MM-DD
sha256: <本 frontmatter 之后正文的 SHA-256>
---
```

Raw 正文不可修改。Ingest 和 re-ingest 检查相关 Raw，lint 检查全部 Raw；在正文
逐字节不变时自动修复可确定的来源字段和 `sha256`，并记入日志。歧义或哈希异常
只报告。用户补全正文时视为新捕获；Agent 重新抓取时保留旧版本。

GitHub 仓库使用 `raw/repositories/` 和
[`github-repositories.md`](github-repositories.md) 定义的规范化来源包。
记录已审阅 Commit、所选文件和清洗步骤，不镜像完整仓库。

## 标签分类体系

[声明 10–20 个领域级标签，并按用途分组。]

AI/ML 示例：

- 模型：`model`、`architecture`、`benchmark`、`training`
- 人物与组织：`person`、`company`、`lab`、`open-source`
- 技术：`optimization`、`fine-tuning`、`inference`、`alignment`、`data`
- 元信息：`comparison`、`timeline`、`controversy`、`prediction`

所有使用中的标签都必须在这里声明。使用新标签前先添加到这里。

## 页面创建门槛

- 两个及以上独立来源实质讨论一个主题，或该主题是单一来源的核心且对领域
  重要时，才创建页面。
- 主题已被覆盖时更新现有统一页面。
- 不为顺带提及或领域外细节创建页面。
- 超过约 200 行的页面拆分为互联子主题。
- 完全过时的页面归档到 `_archive/`。

## 实体页面

包括：

- 核心认识和要解决的问题；
- 关键约束、核心机制与具体工作流程；
- 面向 Obsidian 阅读区的纵向实际架构 Mermaid 图，以及支持主要节点和连接的来源路径；
- 主图除端到端流程外，还保留使项目区别于普通同类系统的身份性组件；次要细节移入
  局部图或正文，不得只为限制节点数而删除；
- 绘图前建立 Architecture Coverage Ledger；绘图后为每个重要组件、关系、状态、
  边界和成熟度限制指定主图、局部图、正文、可选表格或明确省略理由；Ledger 是内部
  质量检查，不默认写入页面；
- 只有图中省略的信息会影响使用、验证、安全、兼容性或成熟度判断，而且正文尚未清楚
  解释时，才增加以读者问题命名的精简表格，不使用“架构覆盖表”作为固定栏目；
- 架构图之后的三至五步阅读说明；
- 关键事实与日期；
- 边界、代价与适用条件；
- 脱离具体项目后仍成立的可迁移认识；
- 与其他实体的关系；
- 来源引用。

对于 GitHub 仓库实体页，架构图必须来自已审阅 commit 的文档、模块布局、入口代码、
配置/插件清单或存储/服务适配器。图中不能把推测的组件关系写成已实现事实；证据不足
时明确标注“架构证据不足”。主图通常以约 8–12 个节点作为可读性目标，但不是硬限制；
每张图只回答一个问题，复杂架构拆成主图和局部图。遮住项目名称后，图仍应能说明它
为何不同于普通同类系统。

## 概念页面

包括：

- 不依赖特定项目名的核心认识；
- 要解决的问题与约束；
- 从约束到结果的因果机制；
- 使机制可见的具体例子；
- 边界、反例、代价或开放争议；
- 至少一个其他情境中的迁移示例；
- 相关概念。

## 比较页面

包括：

- 比较对象和原因；
- 比较维度，优先使用表格；
- 结论或综合；
- 来源。

## 更新策略

新信息与已有内容冲突时：

1. 检查日期和适用范围；已证实的综合错误直接修正并追加日志，真实争议才保留双方。
2. 冲突仍然存在时，保留双方说法、日期和来源。
3. 设置 `contested: true`，并将相关页面 slug 加入 `contradictions`。
4. 交给人工复核。
````

## `index.md`

```markdown
# Wiki 索引

> 内容目录。每个全局综合页面按类型列出，并附一行摘要。
> 学习与研究材料不计入综合页面总数，从材料索引导航。
> 导航或回答查询前先阅读本文件。
> 最后更新：YYYY-MM-DD | 页面总数：0

## 实体

<!-- 按文件名排序 -->

## 概念

## 比较

## 查询

## 学习与研究材料

- [[notes/index|材料索引]]
```

## `notes/index.md`

```markdown
# 学习与研究材料

按主题导航到章节笔记、练习、阅读指南与技术调查。按需添加真实材料入口。
```

## `log.md`

```markdown
# Wiki 日志

> 仅追加的 Wiki 操作时间线。
> 格式：`## [YYYY-MM-DD] 操作 | 主题`
> 操作：ingest、update、save、lint、create、archive、delete；纯查询不写日志。

## [YYYY-MM-DD] create | Wiki 初始化

- 领域：[domain]
- 创建 `SCHEMA.md`、`index.md`、`log.md` 和标准目录。
```

## 综合页面

```markdown
---
title: 页面标题
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: concept
tags: [已声明标签]
sources: [raw/articles/source-name.md]
confidence: medium
---

# 页面标题

## 核心认识

[不用来源专有术语，以一至两句话建立直觉。]

## 要解决的问题

[说明张力、约束和为什么常见做法不够。]

## 核心机制

[用“约束 → 设计选择 → 行为变化 → 结果 → 新代价”解释因果关系。]

## 具体例子

[用一个最小工作示例呈现初始状态、关键转换和结果。假设示例需明确标注。]

## 边界与代价

- [一个失败条件、反例、不适用场景或尚未解决的问题。]

## 可迁移的认识

[提炼不依赖来源名称的决策规则，并说明它如何映射到另一个情境。]

## 相关内容

- [[related-page-one]]
- [[related-page-two]]

## 来源

- [[raw/articles/source-name]]
```
