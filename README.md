---
description: "Capture ideas, draft scripts and images, schedule posts, and reuse writing rules in DeepSeek Harness."
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

English | [中文](README.zh.md)

## Summary

Capture ideas, produce scripts and storyboards, arrange a publishing calendar, and turn feedback into writing rules from a DSH sidebar workbench. This fork packages the community Media Desk plugin for the DSH Creative submodule workflow and fixed Git installation. Text uses configured DSH models; image generation needs a separate image service or compatible registered tool. Publishing remains manual.

## Table of Contents

- [Use this package](#use-this-package)
- [Development](#development)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Install the prebuilt release into DSH `0.2.2-rc.1`, then restart that profile and refresh its browser:

```sh
dsh plugin --profile web add github:winterhuan/dsh-media-desk#v2.6.2-winter.1
```

Open Media Desk in the sidebar. The package includes its Host entry and browser bundle. The upstream npm package and this fork share panel IDs, routes and data; enable only one in a profile. Content stays under `<DSH_HOME>/media-desk/`, with `~/.dsh` as the default home. The [upstream user guide](GUIDE.md) ([中文](GUIDE.zh.md)) explains the five views, settings, account import and file export; its upstream installation commands do not select this fork.

<a id="development"></a>
## Development

Edit `plugins/dsh-media-desk` in the parent repository. Install dependencies from the frozen pnpm lockfile, check syntax, build the browser entry, and run the Host tests:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
```

The upstream source is JavaScript. `typecheck` checks JavaScript syntax in `src`, `scripts` and `test`; the build parses the browser JSX. These commands do not provide static type checking. Build output `dist/client.js` is committed for remote installation without lifecycle builds; regenerate it whenever browser source changes. The npm lockfile remains available for upstream development, while the parent uses pnpm.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The bundle patch](cordis.patch.yml) activates the package Host. [The Host](src/host.js) authenticates `/media-desk` requests and owns content, settings and production. [The browser entry](client/index.jsx) registers the sidebar panel and polls production progress. [The producer](src/produce.js) plans a piece before generating text and images concurrently; [the store](src/store.js) persists content in JSON and media files. The assistant calls the DSH model service directly and applies structured edits without creating native Agent Sessions. Model access and image tools are supplied by the host profile.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Upstream project](https://github.com/woniuniuniu/dsh-media-desk) and [user guide](GUIDE.md) ([中文](GUIDE.zh.md)).
- [DSH Creative handoff](https://github.com/winterhuan/dsh-creative/blob/develop/HANDOFF.md) for submodule ownership and profile operations.
- [MIT license](LICENSE), including the upstream copyright notice.

<a id="model-experience"></a>
## Model Experience

### Workbench context

#### What the model sees

The assistant receives operation instructions, selected content, a compact workspace snapshot and up to eight recent chat messages for that content. Production calls receive the idea, style, active rules and shared plan through [the prompts](src/ai.js). Replies use `reply`, `ops`, `actions` and optional `revise`; the Host validates edits. Image tools receive image prompts, not the workbench chat history.

#### Token effect

Each request resends its selected context. Longer articles, style samples, rules and revisions increase input tokens; production makes separate planning and writing calls, while image requests use the configured backend.

#### KV Cache effect

The plugin does not manage a KV cache. Repeated prompt prefixes may be reused by a provider, while changing content, dates, rules or model selection may reduce prefix reuse; no cache hit is guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compatibility is pinned to DSH `0.2.2-rc.1`. Scheduling does not publish to platforms, image failures can coexist with a completed production, and interrupted Host jobs require restarting production. Data is shared by profiles using the same DSH home. Syntax/build checks and fixture tests do not establish real model or account-service behavior.

### Dev Note

The fork retains upstream business behavior. Future changes belong in this repository, with a rebuilt browser artifact and a new immutable release.
