# Media Desk user guide

English | [中文](GUIDE.zh.md)

## Summary

Capture ideas, research your Wiki through native DSH conversations, edit the current Notes Markdown, and produce scripts and visual assets. The five workbench views retain works, styles, people, schedules and manual performance review. Publishing and video assembly remain manual.

## Table of Contents

- [Start and migrate](#start-and-migrate)
- [Create and continue](#create-and-continue)
- [Use the five views](#use-the-five-views)
- [Images and export](#images-and-export)
- [Notes recovery](#notes-recovery)
- [Costs and limits](#costs-and-limits)
- [Further Exploration](#further-exploration)

<a id="start-and-migrate"></a>
## Start and migrate

Install this fork using [the package instructions](README.md#use-this-package) in the complete DSH `0.2.2-rc.1` Web profile. Open Media Desk in the sidebar. Set `WIKI_PATH` to an existing Wiki on the Agent machine, or use the default `~/wiki`; the Host `wikiPath` setting can override it. Missing Wiki or native components produce an error that identifies the repair needed.

Before using legacy data, stop old Media Desk processes. Open **Recover saves and migrate** and choose **Move legacy work to Notes**. A verified private backup precedes file publication. Work identities, source ideas, drafts, fixed AI originals, selected samples, sources, custom preferences, languages, accepted images, metrics, schedules and settings remain available. Repeating migration reuses its receipt; unknown original languages use `und`.

## Create and continue
<a id="create-and-continue"></a>

Open a work in Studio and send a request in its embedded native conversation. Each work retains one ordinary DSH Session; the global assistant has a separate Session. The workspace entry and workbench open the same history, including tools, approval, questions, attachments and native draft input. Reopening the panel preserves the association.

Choose the text model in the native conversation. A model change reaches the next step that has not prepared its request. **Produce** admits one Host-owned plan attempt; repeated clicks reuse the active attempt. The Agent uses llm-wiki and the selected material, active style, enabled rules and personal voice. A successful accepted plan starts the script and independent image workers. Submitted or streaming candidates become formal text only after the matching successful native turn and Notes save.

Native **Stop** stops the current turn and retains pending input; already admitted images can settle. **Cancel production** stops the whole attempt and its images. Queue edits, removal and steering invalidate changed stage input. You can send again after Stop. **Start a new conversation** first stops active owned work, then binds a fresh Session; the old history, old pending inputs and accepted content remain.

Select a passage in the body and choose **Ask the assistant to edit this**. It enters the native draft with its selected content version. If Notes changes before the edit is accepted, select again from the latest body. Missing, invalid or conflicting Notes files block writes while preserving the editor draft and accepted content.

<a id="use-the-five-views"></a>
## Use the five views

- **Idea wall:** capture notes, ordinary public links and uploads; filter and open a work.
- **Content board:** move works through idea, outline, draft, ready and published.
- **Styles:** choose a writing style and retain custom style cards.
- **Schedule:** place a work on the calendar; publish manually and update its status.
- **Insights:** enter work metrics manually or paste platform-summary CSV; review observations and propose writing rules.

Select a built-in style or extract a custom style from explicitly pasted or selected webpage author samples. Knowledge summaries supply evidence rather than author style. Review generated rule proposals and enable the ones you want. Exporting `media-desk-voice` uses the currently active custom style and rules; an old exported skill cannot silently reactivate a disabled rule.

Automatic account collection and its Monid setup are unavailable. Historical accounts, collected posts, ordinary links and metrics remain. Manual metrics can link to a work; CSV represents platform totals. Imports append records, so importing repeated cumulative snapshots can double count. These summaries do not provide live per-post updates or prove that a writing rule caused an outcome.

<a id="images-and-export"></a>
## Images and export

Configure image count, storyboard count and an image source in Settings. The HTTP source uses the configured OpenAI-compatible Images API and a private key. The tool source reuses compatible `image_generate` registration from `dsh-plugin-subscriptions`, including its collision alias. Tool size and quality are independent of retained HTTP settings. **Generate test image** makes a real paid or quota-consuming request; detection alone does not verify login or quota.

Host tool policy and current subscription-tool preferences apply to background images. A call needing unsupported approval fails; it does not inherit the visible Session’s restrictions or account affinity. Tool failures have no automatic HTTP fallback or additional tool retry. A pure Code Mode/PTC executor cannot directly call this root image tool. HTTP rate-limit retries remain bounded within one image attempt.

Without an image service, accepted script and storyboard descriptions remain useful. A failed image preserves the accepted script and other assets; redraw that image independently. Accepted bytes live once under `notes/assets/<work-title>/`. Files use names such as `cover.jpg`, `image-01.jpg` and `shot-01.jpg`; redraws receive a short suffix. A retained save failure can be retried after repairing storage, without generating again.

**Save** creates a fresh export folder every time, containing the accepted script, storyboard, available images, optional composed video cover, `sources.md` and `manifest.json`. Sources remain separate from spoken text. The manifest identifies the content snapshot, image fingerprints and missing assets. A new plan without its accepted script cannot mix with an old script in an export. Exports with the same title never reuse old folders or files.

<a id="notes-recovery"></a>
## Notes recovery

The **Body** tile edits `notes/works/<title>.md` directly. Titles can change without renaming that file. **Work language** switches retained language versions. Materials use `notes/materials/`; custom voice, styles and rules use `notes/preferences/`; fixed AI originals and earlier formats use `notes/.media-desk/history/<work-id>/`. `notes/index.md` provides managed navigation while retaining unrelated prose.

Recent history and undo each retain five entries. Current drafts, referenced originals, active candidates and editor conflicts remain available. Identical frozen snapshots reuse a file. External byte changes are checked on reads and before acceptance. **Relink work file** accepts a regular owned work file with the same identity and language. For a save failure, repair the reported location or permission, then retry the retained native or media candidate in the recovery dialog. Retry returns an existing receipt when acceptance already succeeded. A stopped or superseded candidate cannot be accepted.

For a version conflict, review the current body and retained external version, then keep the current body or adopt the repaired external version. Both versions and the candidate remain available. Refresh if the file changes again. Undo targets the original accepted edit’s language, preserves later disjoint edits and reports overlapping conflicts without lowering versions.

To organize existing ID filenames and visible history, stop DSH and run the following from this package with the stopped home and Wiki paths. The command creates and verifies a private backup, organizes files and references, consolidates save records and removes expired undo files. Keep this package version when restarting; older packages cannot read renamed media or single save journals safely.

```sh
node scripts/organize-notes.mjs "$DSH_HOME" "$WIKI_PATH"
```

For offline rollback, stop the selected DSH writer. In the built checkout, set `DSH_HOME`, `WIKI_PATH` and `MEDIA_DESK_MIGRATION_ID` to the stopped profile’s home, Wiki and verified backup ID, then run:

```sh
node src/notes-rollback.js "$MEDIA_DESK_MIGRATION_ID"
```

Rollback verifies and restores pre-migration data while preserving post-migration files, displaced editor evidence and native Session logs. Restart with the old package and restored data. The old package cannot read the new Notes reference format safely.

<a id="costs-and-limits"></a>
## Costs and limits

The plugin supplies no model credentials. Text uses the native Session model account; images use the selected image service or subscription quota. Credentials stay in the private DSH/settings storage. Provider availability, factual accuracy and writing quality need separate checks. Same-machine cooperative directory locks cover Media Desk Hosts, while ordinary editors require byte checks and retained-version recovery. Cross-machine shared-folder writes and exactly-once external billing are unsupported.

<a id="further-exploration"></a>
## Further Exploration

- [Package contract and development](README.md)
- [Original project](https://github.com/woniuniuniu/dsh-media-desk)
- [MIT license and original attribution](LICENSE)

### Dev Note

None.
