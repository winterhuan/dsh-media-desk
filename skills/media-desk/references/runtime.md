# 文件读取与校验

`media-desk` CLI 与插件由同一个 npm 包 `@winterhuan/dsh-media-desk` 提供，复用 Notes 文件解析和校验。Agent 用文件工具直接读写正文、材料、文风和规则文件；CLI 只读取登记信息与当前字节，报告身份、格式和指纹，不保存、登记、修复、生成快照或接受成果。

## 命令

安装该 npm 包后使用 `media-desk`；包目录中也可直接执行 `node scripts/media-desk-read.mjs`。当前 checkout 的包内调用示例：

```sh
node scripts/media-desk-read.mjs --help
node scripts/media-desk-read.mjs read --kind work --id <work-id>
node scripts/media-desk-read.mjs read --kind preferences
node scripts/media-desk-read.mjs read --file /absolute/wiki/notes/works/article.md
node scripts/media-desk-read.mjs validate --file /absolute/wiki/notes/works/article.md
```

`read` 支持 works、work、preferences、materials、metrics、people。作品读取返回当前文件、实际 sha256、登记版本与是否已变化，并读取已有固定 AI 原稿。偏好读取保留已登记的启用状态，也读取目录中的有效待审提案，未登记的提案返回 registered:false 和 status:proposed。ruleFileIssues 列出无效文件、身份冲突和精确重复的路径与原因。`--file` 也可检查尚未登记的内容文件；校验不会写入登记数据。

`validate --sha256 <读取时的指纹>` 可检查文件是否已变化；这是修改前的辅助检查，不是编辑锁。修改后不继续用旧指纹校验新正文。文件或指纹无效时退出码为 1；CLI 不自动改文件。

用 `--data-root` 指定插件登记数据目录，`--wiki` 指定内容库。省略时与插件一致，使用 `<DSH_HOME>/media-desk`，DSH_HOME 未设置时为 `~/.dsh/media-desk`；内容库使用 WIKI_PATH 或 `~/wiki`。已登记文件沿用其保存的 Notes 根目录。CLI 不取得插件写锁，也不启动服务或连接聊天。

输出为 JSON。大对象使用 `--offset` 与 `--limit` 读取连续 JSON 文本片段，nextOffset 为 null 表示结束；limit 为 1–20000 字符，默认 12000。CLI 不自动创建结果文件。

## 内容文件

当前作品为 `notes/works/<标题>.md`，元数据包含 format:1、kind:work、id、title、createdAt、updatedAt、language、tags 和 sources。正文位于 frontmatter 后。已登记作品的 id 和 language 保持不变；来源字段及其他有效元数据一并保留。

材料为 `notes/materials/<id>.md`；文风为 `notes/preferences/styles/<id>.md`；规则为 `notes/preferences/rules/<id>.md`；个人语气为 `notes/preferences/voice.md`。这些文件的元数据包含 format:1、kind、id、updatedAt，材料／文风／规则的文字字段位于 data 中；材料正文与个人语气使用 Markdown 正文。CLI 返回实际字段供 Agent 修改，不另造平行文件格式。含特殊字符的 id 使用读取结果中的文件路径。

固定 AI 原稿和历史位于 `notes/.media-desk/history/`，只读。校验读取不会追加历史；插件读取已登记文件的变化时维护自己的索引与历史。

## 登记与业务状态

插件读取或刷新时发现 `preferences/rules/` 下符合格式的新规则文件，以待审状态登记，保留原文件字节并建立版本记录。规则正文和适用范围都相同的提案不会重复登记；语义去重由 Agent 完成。删除规则会保留删除身份，残留文件不会让它复活；重新提案使用新 ID。文件中的 status 不会启用规则，启用状态由用户在插件中设置。无效或缺失规则不能启用。

新增作品、材料或风格文件可以校验，但仍需登记才能出现在工作台。人物、创作角度、排期、指标、媒体身份及运行回执尚存于插件业务数据中，不能通过修改正文或手改 state.json 代替相应操作。

## 规则提案

Agent 用文件工具新建 Markdown，文件名是 encodeURIComponent(id) 加 `.md`。name、rule、scope、evidence 必填，改写示例同时提供 before 与 after；source 记录作品身份和比较时的正文 sha256，relatedRuleId 仅关联已有相近规则。例如：

```yaml
---
format: 1
kind: rule
id: s_statement-headings
updatedAt: 2026-11-22T07:00:00.000Z
data:
  name: 用小标题表达具体发现
  rule: 技术分析文章的小标题表达机制或发现，避免“原理一”等策划标签。
  scope: 技术分析文章的小标题
  evidence: 作者将策划标签改为表达机制的陈述句。
  source: it_mwhr417kafz sha256 <比较时的正文指纹>
  before: 原理一
  after: 订阅给了上下文，没给授权
---
```

保存后执行 `media-desk validate --file <绝对路径>`，再执行 `media-desk read --kind preferences` 核对待审提案与 ruleFileIssues。插件打开或点击“写作规则 → 刷新”会登记有效提案；在“风格 → 写作规则”审阅启用。没有运行插件时保存仍可完成，下一次插件读取时接续登记。复盘记录 `preferences/reviews/<作品 ID>.md` 是普通 Markdown，由文件工具读写，CLI 不解析为规则。

插件的制作、登记、媒体接受和历史恢复由[执行适配](plugin-adapter.md)管理。该层保留现有兼容能力；业务流程不按其执行环境分叉。完整的文件驱动接续还需要这些业务数据的文件协议，当前不能宣称已完成。
