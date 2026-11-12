---
description: "Capture ideas, continue native conversations with your Wiki, produce scripts and images, and schedule posts in DeepSeek Harness."
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

English | [中文](README.zh.md)

## Summary

Capture ideas, produce scripts and storyboards, arrange a publishing calendar, and reuse writing rules from a DSH sidebar workbench. Open persistent native DSH conversations for each work and a separate global assistant, using an existing Wiki and the Media Desk creative preset. Image generation uses a separate service or compatible registered tool. Publishing remains manual.

## Table of Contents

- [Use this package](#use-this-package)
- [Development](#development)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

From a built checkout, install into a separate DSH `0.2.2-rc.1` Web profile and open the URL printed by DSH:

```sh
dsh --profile media-desk-dev --from-default-profile web --dump-config
dsh plugin --profile media-desk-dev add "link:$PWD"
dsh --profile media-desk-dev --port 0 --no-open
```

Open Media Desk in the sidebar. The package includes its Host entry and browser bundle. The upstream npm package and this fork share panel IDs, routes and data; enable only one in a profile. Content stays under `<DSH_HOME>/media-desk/`, with `~/.dsh` as the default home. The [upstream user guide](GUIDE.md) ([中文](GUIDE.zh.md)) explains the five views, settings, account import and file export; its upstream installation commands do not select this fork.

<a id="native-conversations"></a>
### Native conversations

Use **Global native session** in the workbench header or **Native session** in a work's Studio header. Each entry opens DSH's ordinary Session page, with native input, model selection, tool history, questions and approvals. A new work Session uses the work's title; the global Session has a separate assistant title. Native renames are preserved. Closing the workbench or restarting DSH preserves the associated Session; reopen it from the workbench or native workspace tree.

A new association uses the existing `WIKI_PATH` directory, or `~/wiki` when unset. Host configuration `wikiPath` overrides that choice. The resolved Wiki also determines the workspace and `<Wiki>/notes` root; no missing Wiki is created. A saved association keeps its root after an environment change. Changing the native workspace or preset requires restoring the bound Wiki and Media Desk preset before opening it from the workbench again.

The native Session's selected model controls its conversation. The workbench model picker only seeds a new native association. Missing native services, preset or Wiki cause an explicit failure; existing associations remain available for inspection. Keep the same DSH home and restore the required profile components to continue an existing conversation.

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

The [native runtime fixture](test/fixtures/native-runtime.js) installs an isolated official Web profile and executes actual Loader, SessionController and tools against a temporary Wiki. Its model adapter controls only the external model response. The [skill instruction record](test/fixtures/llm-wiki.instructions.json) identifies the frozen `llm-wiki` instruction files; no personal Wiki pages are included.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The bundle patch](cordis.patch.yml) activates the package Host and a dedicated creative preset. [The Host](src/host.js) authenticates `/media-desk` requests and initializes one content Store before publishing its service for cold native recovery. [Native associations](src/native-sessions.js) persist the actual identity returned by the public controllers together with the DSH home, preset and initial model. DSH's SessionController owns live Agents; page navigation only changes Client subscriptions. [The browser entry](client/index.jsx) registers the sidebar panel and opens those saved Sessions. [The producer](src/produce.js) and [store](src/store.js) retain the workbench's production and JSON/media persistence paths.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Upstream project](https://github.com/woniuniuniu/dsh-media-desk) and [user guide](GUIDE.md) ([中文](GUIDE.zh.md)).
- [DSH Creative handoff](https://github.com/winterhuan/dsh-creative/blob/develop/HANDOFF.md) for submodule ownership and profile operations.
- [MIT license](LICENSE), including the upstream copyright notice.

<a id="model-experience"></a>
## Model Experience

### Native creative context

#### What the model sees

Native conversations receive a creative persona, bound work/global identity and Wiki paths, local instructions, current time and ordinary Session history through [the creative context](src/native-context.js). The preset provides file, search, Shell, skill, web, question, approval and compaction capabilities. The effective `llm-wiki` skill reads selected pages and dated sources; it does not inject the whole Wiki. Topic summaries supply facts; only selected author samples supply personal writing style. Coding, plugin management, scheduling, goals and delegation workflows are absent from this preset.

#### Token effect

Ordinary Session history, loaded skill instructions and selected file contents increase input tokens. Wiki research loads the relevant query instructions and matching pages rather than every page.

#### KV Cache effect

Native conversations use DSH's model adapter and cache behavior. Media Desk adds no cache configuration or hit guarantee.

### Workbench context

#### What the model sees

The assistant receives operation instructions, selected content, a compact workspace snapshot and up to eight recent chat messages for that content. Production calls receive the idea, style, active rules and shared plan through [the prompts](src/ai.js). Replies use `reply`, `ops`, `actions` and optional `revise`; the Host validates edits. Image tools receive image prompts, not the workbench chat history.

#### Token effect

Each request resends its selected context. Longer articles, style samples, rules and revisions increase input tokens; production makes separate planning and writing calls, while image requests use the configured backend.

#### KV Cache effect

The plugin does not manage a KV cache. Repeated prompt prefixes may be reused by a provider, while changing content, dates, rules or model selection may reduce prefix reuse; no cache hit is guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compatibility is pinned to the complete DSH `0.2.2-rc.1` Web profile. Scheduling does not publish to platforms, image failures can coexist with a completed production, and interrupted Host jobs require restarting production. Profiles using the same DSH home share workbench data and associations.
- Native conversations and the embedded workbench assistant have separate histories. The embedded assistant, production and style extraction retain direct model calls. Syntax/build checks and controlled-model fixtures do not establish real model or account-service behavior.
- Interrupted or failed native creation stays pending. Inspect `/media-desk/sessions` or `<DSH_HOME>/media-desk/sessions.json` for its error and actual Session ID when available. Automatic replacement and pending-creation recovery are unavailable.

### Dev Note

None.
