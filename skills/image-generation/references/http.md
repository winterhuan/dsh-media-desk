# HTTP 图片执行

使用用户已选定的 OpenAI-compatible Images、百炼同步或万相异步生图服务。全局 skill 不借用某篇文章的正文、规则或作品存储；调用方传入渠道配置和画面要求。当前通用脚本支持文字生成图片；编辑或参考图请求交给实际支持该能力的内置、Lupi 或其他所选渠道，不能将参考图忽略后宣称编辑成功。

## 独立运行

默认读取用户级 `~/.config/image-generation/.env` 的 `IMAGE_URL` 与 `IMAGE_API_KEY`；设置 XDG_CONFIG_HOME 时使用 `<XDG_CONFIG_HOME>/image-generation/.env`。当前目录 `.env` 或 `--dotenv` 指定文件覆盖全局值，已导出的同名环境变量优先。`IMAGE_URL` 可填服务根地址（如 `https://images.example/v1`）或完整的 `/images/generations` 地址，脚本只追加一次路径。默认模型为 `gpt-image-2`，`IMAGE_MODEL` 可选，`--model` 优先于配置模型。

```dotenv
IMAGE_URL=https://images.example/v1
IMAGE_API_KEY=<private-key>
# Optional
IMAGE_MODEL=gpt-image-2
```

```sh
node /absolute/image-generation/scripts/generate.mjs --help
node /absolute/image-generation/scripts/generate.mjs --prompt-file /absolute/prompt.txt --out /absolute/new-image-result
node /absolute/image-generation/scripts/generate.mjs --dotenv /absolute/project/.env --model gpt-image-2 --prompt-file /absolute/prompt.txt --out /absolute/other-image-result
```

全局文件使任意工作目录都可直接执行；需要另一份配置时显式传入 `--dotenv`，指定文件缺失即报错。当前目录没有 `.env` 时使用全局文件与已导出的环境变量；缺少地址或密钥则在请求前报错，不切换到内置生图。脚本解析 `.env`，不执行其中内容，也不修改该文件。

现有私有 JSON 配置可显式用 `--config /absolute/private-config.json` 指定；不再默认读取 `~/.config/image-generation/config.json`。显式配置的 baseUrl 和密钥来源优先于默认 `IMAGE_URL/IMAGE_API_KEY`，可包含 protocol（openai、bailian 或 wan，默认 openai）、model、size、quality、extra；密钥来自 apiKeyEnv 指定的环境变量（默认 `IMAGE_GENERATION_API_KEY`）或私有 apiKey。extra 是服务要求的 JSON 字符串，size 和 quality 使用服务支持的值。环境文件与私有配置保持私有权限；实际密钥不写进提示词、回执或日志。

out 必须是尚未存在的目录，其父目录需已存在。目录中包含实际图片扩展名的 image 文件和 receipt.json。再次使用同一个目录会在请求前拒绝，不覆盖结果。回执记录请求身份、提示词哈希、模型、已保存图片哈希以及 prepared/uncertain/save-failed/saved 状态；回执本身不等于图片已生成或通过视觉检查。失败后读取回执和现有图像，与服务核对；不通过换目录掩盖尚未确定的请求结果。

## 嵌入宿主

`http.mjs` 的 generateImage(image, prompt, {signal,fetchImpl?,translate?,pollIntervalMs?}) 返回 {buffer,ext}；imageBuffer 校验接受的图片字节，imageUrlCandidates 处理网关返回的路径。配置明确指定的接口及同源下载允许本地服务；其他下载地址执行公网检查，不把提供方返回的任意文件路径当成本机文件。

`dsh-tool.mjs` 的 imageTool(ctx) 只发现公共注册；generateToolImage(ctx,image,prompt,{signal,home,translate?}) 使用宿主执行器及私有订阅目录，返回相同的字节结构。纯 Code Mode 执行器无法直接执行根图片工具时明确失败；宿主仍负责问题、批准和账号限制。适配器不创建聊天会话或业务作品。

Media Desk 将已有图片设置作为调用配置传入这两个执行器，保留当前选定的渠道和私有凭据位置。全局技能可以使用自己的独立配置，调用本身不迁移或覆盖其他应用设置。
