# 插件执行适配

插件兼容执行层随 Media Desk 包提供 `scripts/media-desk.mjs`，复用 Store、Notes、Settings、MediaFiles 和保存回执。技能目录中的 `scripts/media-desk.mjs` 与 npm 命令只提供读取和校验；业务操作使用包根目录下的执行适配。需要 Node >=22.19 与已安装依赖的包。无需启动 DSH 服务即可 standalone 执行；同一个 data home 与 Wiki 的插件启动后直接读回。

```sh
node /absolute/media-desk-package/scripts/media-desk.mjs read --mode standalone --home /absolute/dsh-home --wiki /absolute/wiki --input /absolute/read.json
node /absolute/media-desk-package/scripts/media-desk.mjs commit --mode plugin --input /absolute/commit.json --login-log /absolute/live.log
```

默认 home 为 DSH_HOME 或 ~/.dsh/profiles/media/data，Wiki 为 WIKI_PATH 或 ~/wiki。本机日常 plugin 的地址为 http://127.0.0.1:3085。认证从指定实时日志或 MEDIA_DESK_LOGIN_URL 读取，令牌不写入输出。不同 profile 显式传 URL 和日志。auto 在可认证 Host 上运行；显式 home 选择离线数据，不自动切去另一 profile。旧发布包不含 skill 接口时报版本缺口，不绕开校验。

所有输入是 JSON 对象。大结果保存到私有 resultFile；需要完整对象时读取该文件。--out 必须为尚未存在的路径。

| action | input |
|---|---|
| read | {kind:"works"}；{kind:"work",id}；kind 也可 preferences、metrics、people、requests |
| ops | {operations:[{op:...,id,...}],expectedContent:{[id]:{revision,sha256}},expectedPreferences?:{"style:<id>"或"rule:<id>":{revision,sha256}},resultId?,label?} |
| begin | {id,requestId,format:"article"或"script",withImages?}，返回 request 与冻结 preferences |
| commit | {requestId,plan:{...},result:{article,sources,ruleChecks},engine?} |
| rules | {result:{rules:[{name,rule,evidence,scope,before?,after?,relatedRuleId?}]},learningSource?,resultId?} |
| style | {result:{name,summary,tone,sentences,opening,structure,logic,story,flow,words,avoid,samples},sourceUrls?,sampleMaterial?,resultId?} |
| cancel | {requestId}，取消尚未接受的独立制作请求 |
| capture | {url,title?,note?,tags?,language?,textOnly?}，textOnly 只读网页全文 |
| upload | {file:"绝对路径"}，返回 media.src 与 kind |
| asset | {id,target:"cover"或"image:0"或"shot:0",file:"本地图像",expectedContent,renderId?} |
| redraw | {id,target}，使用已配置图片服务；离线不调用仅在 Host 注册的订阅工具 |
| revise | {id,revision:{coverText,cover,images,shots,article?,edits?},expectedContent,resultId?}，画面序号 1 起 |
| export | {id,directory?,expectedContent} |
| settings | {} 读取公开配置；{patch:{voice?,image?,imageCount?,shotCount?,generateImages?,language?,exportDir?}} 更新 |
| insights / recovery | {} |
| undo / validate | {id} |
| retry | {kind:"notes"或"media",id} |
| version / resolve | {id?,workId?,relativePath?,sha256?,choice?}，按 recovery 返回的身份与版本填写 |
| register | {id,language,relativePath} |
| language | {id,language,expectedContent} |
| migrate | {}，沿用备份与回执机制 |
| voice-export | {home:"导出技能的配置根目录"} |
| api | **仅 plugin 模式**：{path:"sessions"或其他现有 Host 路由,body?}，body 缺省 GET，否则 POST |

ops 支持现有 add/update/delete_item、save_draft、update_production、schedule_item、set_status、add/update/delete_person、add/update/delete_angle、add/update/delete_style、set_style、add/update/delete_skill、add_metric、add/update/delete_account 与 clear_samples。不要用原生专属 revise_production 操作；使用 revise。

现有 Host 路由还提供 sessions/open、sessions/retry、chat/clear、produce（原生生产）、produce/cancel、produce/regen、produce/save、produce/reveal、native/retry、media/retry、notes/register、notes/relink、notes/language、notes/version、notes/resolve、notes/retry、notes/migrate、notes/migrations、notes/saves、media/saves、settings/test、style/extract、skills/learn、skills/export。api 的 JSON 字段以当前包 GUIDE/源码和读取结果为准，实际发出文字或生图任务前沿用户本次授权。

## Notes 格式与互通

当前作品位于 notes/works/<标题>.md，frontmatter 保留 format:1、kind:work、id、title、createdAt、updatedAt、language、tags、sources；材料在 materials，风格和规则在 preferences，固定原稿在 .media-desk/history。通过共用内核保存，插件业务引用、媒体登记、历史与索引同时更新，不需要手动扫描或导入。

同一 home 的插件直接续用；迁往另一个 home 时使用现有备份/迁移流程，不能只复制 Markdown 后宣称人物、排期、规则状态和媒体引用都已迁移。独立模式与 plugin 模式只有执行载体不同，作品数据格式相同。
