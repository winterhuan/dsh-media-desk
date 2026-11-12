---
description: "Capture ideas, edit work Markdown in Wiki Notes, continue native conversations, produce scripts and images, and schedule posts in DeepSeek Harness."
kind: "package-bundle"
---

# @winterhuan/dsh-media-desk

English | [中文](README.zh.md)

## Summary

Capture ideas, edit registered work Markdown directly in Wiki Notes, produce scripts and storyboards, and arrange a publishing calendar from a DSH sidebar workbench. Each work and the global assistant can use a persistent native DSH conversation with the Media Desk creative preset. Image generation uses a separate service or compatible registered tool. Publishing remains manual.

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

Open Media Desk in the sidebar. The package includes its Host entry and browser bundle. The upstream npm package and this fork share panel IDs, routes and data; enable only one in a profile. Workbench state and settings stay under `<DSH_HOME>/media-desk/`, with `~/.dsh` as the default home; registered work text lives in Wiki Notes. The [upstream user guide](GUIDE.md) ([中文](GUIDE.zh.md)) explains the five views, settings, account import and file export; its upstream installation commands do not select this fork.

<a id="native-conversations"></a>
### Native conversations

Use **Global native session** in the workbench header or **Native session** in a work's Studio header. Each entry opens DSH's ordinary Session page, with native input, model selection, tool history, questions and approvals. A new work Session uses the work's title; the global Session has a separate assistant title. Native renames are preserved. Closing the workbench or restarting DSH preserves the associated Session; reopen it from the workbench or native workspace tree.

A new association uses the existing `WIKI_PATH` directory, or `~/wiki` when unset. Host configuration `wikiPath` overrides that choice. The Wiki determines the workspace and `<Wiki>/notes` root; a registered work uses its saved Wiki even for its first Session. Saved work and Session roots survive an environment change, including a symlinked Notes directory. Missing saved Wiki directories are not rebuilt. Changing the native workspace or preset requires restoring the bound Wiki and Media Desk preset before opening it from the workbench again.

The native Session's selected model controls its conversation. The workbench model picker only seeds a new native association. Missing native services, preset or Wiki cause an explicit failure; existing associations remain available for inspection. Keep the same DSH home and restore the required profile components to continue an existing conversation.

<a id="notes-work-files"></a>
### Notes work files

New works use `notes/works/<work-id>-<language>.md`, with `und` for an unknown language. The **Body** tile reads and edits that registered Markdown directly, including before production. Use **Edit**, then **Save**; the tile shows the relative file path and content version. Saving a draft or accepting production text selects it as the same current body. Distinct original source text is retained under `notes/materials`, while inactive drafts and fixed AI originals use `notes/history/<work-id>/`. Store keeps references and structured production metadata.

For an existing work, choose **Register work file** and explicitly select a `works/*.md` path relative to its Notes directory. A saved Session's Wiki takes precedence over the current default. Prepare the file with the Work ID shown by the form and its declared language:

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

Only registered work files become managed works. `notes/index.md` receives this data directory's navigation block; unrelated prose, links and notes remain intact. Editing the title does not rename the file. External byte changes are checked on reads and before edits or model-text acceptance, even when mtime is unchanged. Focused works refresh automatically. A stale save keeps the editor draft visible; **Cancel edits and reread** returns to the latest file. Missing, renamed or invalid files show a repair state. **Relink work file** accepts only a regular file in the owned Notes `works` directory with the same Work ID and language; it does not reconstruct the body.

Each Host holds cooperative locks on its canonical data directory and every saved or selected Notes root before initializing Store, Settings or Notes. Another Host sharing either directory stays unavailable without initializing content; other plugins remain usable. Normal plugin disable cancels owned work, waits for its writes and external cleanup, then releases ownership. Stop old releases before using this storage layout: they do not participate in these locks.

Use **Recover saves and migrate** in the workbench header to move legacy work and its saved language versions to Notes after a verified backup. The **Work language** selector switches among retained versions. Failed saves keep their candidates; retry returns the original acceptance receipt without generating again. Conflict review lets you retain the current body or select a preserved external version. Undo reverses the accepted edit while retaining later disjoint changes. See [Notes recovery](GUIDE.md#notes-recovery) ([中文](GUIDE.zh.md#notes-recovery)) for migration, repair and offline rollback.

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

[Notes storage tests](test/notes-storage.test.js) cover public reads, edits, registration, repair and saved-root binding. [Recovery](test/notes-recovery.test.js), [undo](test/notes-undo.test.js) and [migration](test/notes-migration.test.js) exercise retained files and receipts through the public Host. [Ownership tests](test/write-ownership.test.js) use independent processes and held public Store operations to check contention, write drain and terminated-owner recovery.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The bundle patch](cordis.patch.yml) activates the package Host and a dedicated creative preset. [The Host](src/host.js) authenticates `/media-desk` requests and serializes edits through [directory ownership](src/write-owner.js). [Notes](src/notes.js) projects registered Markdown into [Store](src/store.js) reads and removes current or historical text copies from durable registered-work rows. [Native associations](src/native-sessions.js) persist actual controller identities, Wiki/Notes roots, DSH home, preset and initial model. DSH's SessionController owns live Agents; page navigation only changes Client subscriptions. [The browser entry](client/index.jsx) registers the sidebar panel and opens saved Sessions. [The producer](src/produce.js) preserves structured plans and uses the same registered body for accepted text.

[Saved writes](src/notes-writes.js) retain independent candidates, accepted preimages and displaced editor files before publication. One Store replacement accepts references, receipts and associated structured data; notifications follow. [Inverse edits](src/notes-undo.js) use fixed before/after versions, while [migration](src/notes-migration.js) verifies backups and keeps rollback evidence outside the Wiki.

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

The assistant receives operation instructions, selected content, a compact workspace snapshot and up to eight recent chat messages for that content. Registered work text is read from Notes for the snapshot. Production calls receive the current work, style, active rules and shared plan through [the prompts](src/ai.js). Replies use `reply`, `ops`, `actions` and optional `revise`; the Host validates edits and rejects stale registered-text versions. Image tools receive image prompts, not the workbench chat history.

#### Token effect

Each request resends its selected context. Longer articles, style samples, rules and revisions increase input tokens; production makes separate planning and writing calls, while image requests use the configured backend.

#### KV Cache effect

The plugin does not manage a KV cache. Repeated prompt prefixes may be reused by a provider, while changing content, dates, rules or model selection may reduce prefix reuse; no cache hit is guaranteed.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Compatibility is pinned to the complete DSH `0.2.2-rc.1` Web profile. Scheduling does not publish to platforms, image failures can coexist with a completed production, and interrupted Host jobs require restarting production. Profiles using the same DSH home share workbench data and associations.
- Native conversations and the embedded workbench assistant have separate histories. The embedded assistant, production and style extraction retain direct model calls. Syntax/build checks and controlled-model fixtures do not establish real model or account-service behavior.
- Interrupted or failed native creation stays pending. Inspect `/media-desk/sessions` or `<DSH_HOME>/media-desk/sessions.json` for its error and actual Session ID when available. Automatic replacement and pending-creation recovery are unavailable.
- Work migration preserves legacy text, drafts, fixed AI originals and saved languages. Settings, reusable preferences, metrics and media keep their existing storage. Overlapping inverse edits require conflict repair; failed undo retains its record. Task-owned candidates need their task validation before a save retry can accept them.
- Cooperative locks cover same-machine local Hosts. Ordinary editors do not take them. Retained editor handles can change displaced files after acceptance; subsequent reads preserve both versions and report a conflict. Notes publication and Store acceptance are separate steps, with a recovery journal rather than a filesystem transaction. DSH can force process exit after its five-second shutdown timeout, leaving production interrupted even when the launcher exits with code zero.

### Dev Note

None.
