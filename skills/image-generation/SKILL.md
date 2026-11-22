---
name: image-generation
description: Generate, edit and inspect raster images across projects, choosing the user's image channel and returning saved files. Use for standalone image requests or visual production requested by another skill, including covers, article illustrations and storyboards.
---

# 全局生图

统一图片生成、修改、渠道选择和结果检查。任何项目或业务 skill 都可以调用；本技能交付图像文件，调用方负责把图像登记为文章、幻灯片或其他业务素材。

## 选择渠道

默认文字生图读取用户级 `~/.config/image-generation/.env` 中的 `IMAGE_URL` 和 `IMAGE_API_KEY`（设置 XDG_CONFIG_HOME 时使用该目录）。当前项目 `.env`、显式 `--dotenv` 和已导出的环境变量可覆盖默认值，通过本技能的 HTTP 脚本执行。用户本次指定或调用方已选定其他渠道时沿用其选择，不因另一个渠道可用而自动切换。

- 默认兼容 HTTP 图片服务：读取 [references/http.md](references/http.md)，使用本技能 `scripts/generate.mjs`。默认模型为 `gpt-image-2`，可用 `IMAGE_MODEL` 或 `--model` 指定；其他目录的环境文件用 `--dotenv` 传入。独立脚本仅依赖 Node >=22.19；整个技能目录可以单独复制使用。
- 用户指定 Codex 内置生成与编辑：使用实际可用的 `imagegen` 技能及其内置图像工具，遵循它的输入图片和输出文件规则。
- 用户指定 Lupi：读取实际安装的 `lupi-imagegen`，使用它的配置、执行脚本和回执。不要将 Lupi 改成所有项目的默认值。
- DSH 订阅工具：宿主通过 `scripts/dsh-tool.mjs` 调用公共工具注册和执行接口。只在实际注册并允许直接执行时可用；独立 Node 脚本不能替代订阅登录或 DSH 执行器。

内置与 Lupi 入口未安装时先发现对应技能或工具。缺少指定渠道时说明缺口；已获得结果但保存失败时核对原文件或回执，不重新生成。不得把一个渠道的失败当作自动换渠道的授权。

## 输入与执行

从调用方接收用途、提示词、实际文字、画幅、质量、参考图以及必须保持的部分。区分参考图与编辑目标。当前图片的修改先读取图片，只修改用户要求的内容。

提示词保留用途、主体、构图、风格和必要约束；精确文字原样提供。调用方给出的封面留白、文章对应关系、分镜连续性属于本次任务，不成为所有图片的默认风格。请求多张图时逐项保留身份，不把不同提示词合成一个变体请求。

生成或编辑后查看实际图像，检查文字、主体、构图、尺寸和参考图保持要求。文件校验只识别图片字节和大小，不代替视觉检查。修订针对明确缺陷，报告实际模型、图像路径与未解决问题。

凭据由所选渠道私有配置或环境提供，不进入提示词、技能正文、命令参数或业务导出。HTTP 和工具运行时保留取消信号、下载路径校验和有界请求；HTTP 对网络或服务错误最多内部重试一次，订阅工具不增加重试。结果不明时先核对已有请求，不重复整个任务。

## 返回调用方

返回可用的本地图像、渠道、实际模型和检查结果。渠道返回远程媒体且所在应用限制下载时，沿该渠道的原生媒体交付规则处理。

Media Desk 从自己的计划提供 cover、image:N、shot:N 身份和画面要求；完成后由 Media Desk 的 asset/MediaFiles 接受图像并记录版本、来源和保存回执。本文角色、文章事实、排期、Notes 身份与作品正文仍由调用方管理。
