# 研究、策划与制作

读取当前作品、选定材料、人物与创作角度、语气、风格和启用规则。用户要求重新生成时也保留已有来源及已确认的修改要求。

## 研究与策划

Read writing preferences before planning. Research the relevant Wiki with llm-wiki, verify sources and prepare a production plan. Use selected material, style and active rules within their scope. Read the selected author sample and follow its expression, sentence breaks, reasoning, storytelling and transitions; do not copy its claims or wording. Return dated sources and evidence limits.

按证据展开机制、权衡与限制；参数、引用和实验结论要能回到来源。翻译引用标明意译，不冒充原话；缺失信息保留未知，不虚构个人实测或经历。标题与篇幅遵循本次请求、体裁及适用偏好。

策划包含标题、关键事实、论述结构和来源。需要图片时附封面、配图或分镜画面要求，写清正文对应位置；需要口播时附景别、画面、台词、时长和统一人物设定。图片数量沿用本次选择，文字稿也可保留画面规划供之后制作。

## 成稿与自检

Write a complete Markdown article in natural paragraphs, or a spoken script with one sentence per line, based on the plan, facts and sources. Use this task's recorded writing preferences. Check every enabled rule and fix violations before delivery.

Agent 直接写入当前正文文件。每条规则记录适用或不适用的判断及具体段落依据，不能把发现的违规留给用户修复。事实、引用与来源另行核对；完整结构和合法字段不证明语义正确。完成后运行文件校验，修复错误，再报告文件与完成状态。

## 图片与分镜

用户需要图片时，将封面、配图和分镜要求交给全局 [image-generation](../../image-generation/SKILL.md)。Media Desk 提供用途、正文对应关系和素材身份，生图技能执行生成或编辑并检查实际图像。

- 封面有明确主体与构图，底部留出标题空间，默认无文字、无 logo。
- 配图对应文章机制或场景，保持统一视觉语言。
- 分镜默认黑白铅笔线稿、16:9 横向、满画面、无边框和编号，保持人物、服装、位置与场景一致。
- 用户指定文字或其他风格时沿用其要求。只重画指定目标，保留其他素材。
- 生成结果保留本地文件、来源与对应关系。业务登记和图片校验分别核对；保存失败先恢复已有图片，不重新生成。

视频封面文字需要编辑时提供已生成封面和精确文字，保留原图与编辑结果。视频剪辑与平台发布不属于当前制作交付。

## 导出

整理当前正文、来源、分镜表和可用图片，记录正文版本与缺失项。需要新的导出副本时使用新目录，避免混合旧正文和新策划。Agent 写入导出文件后检查实际文件、图片引用与内容一致性。
