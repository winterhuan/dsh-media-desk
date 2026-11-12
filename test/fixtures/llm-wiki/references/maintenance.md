# Wiki 写入与维护

用于入库、保存综合、核查、修订、初始化与材料整理。知识库根目录由
[技能入口](../SKILL.md) 解析；本文中的库内路径和命令均以该根目录为基准。

Build and maintain a persistent, compounding knowledge base as interlinked
Markdown files, based on [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Compile sources into canonical pages that later work reads, reconciles, and
improves instead of rediscovering the same knowledge from scratch.

The human curates sources and directs analysis. The agent captures, summarizes,
cross-references, files, and maintains consistency.

The synthesis target is understanding, not coverage. A useful page should let a
reader explain the subject in their own words, understand why it works, know
where it stops working, and transfer the underlying idea to a new situation.

## Language

Write agent-authored wiki content in Simplified Chinese by default, including
`SCHEMA.md`, index summaries, log entries, synthesized pages, and user-facing
reports. A user's explicit language request or an existing wiki's `SCHEMA.md`
takes precedence.

Keep raw source bodies in their original language and never translate or
rewrite them after capture. Raw frontmatter may be repaired under the narrow
metadata rules below. Preserve code, commands, API names, product names, and
direct quotations in their original form when translation would reduce
precision. A non-Chinese source should normally produce Chinese synthesis.

Expected structure:

```text
wiki/
├── SCHEMA.md
├── index.md
├── log.md
├── raw/
│   ├── articles/
│   ├── papers/
│   ├── repositories/
│   ├── transcripts/
│   └── assets/
├── entities/
├── concepts/
├── comparisons/
├── queries/
└── notes/
    └── index.md
```

The layers have distinct ownership:

1. `raw/`: source bodies are immutable; source-record and integrity fields in
   frontmatter are repairable without changing the body.
2. `entities/`, `concepts/`, `comparisons/`, `queries/`: agent-maintained Global
   Wiki synthesis and the only canonical knowledge layer.
3. `notes/`: topic-organized learning and research materials, indexed by `notes/index.md`.
4. `SCHEMA.md`: domain-specific rules, taxonomy and update policy.

## Orient Before Every Operation

For read-only queries, use [query.md](query.md).
Do not load maintenance history or write a query log for a read-only lookup.

For an existing wiki, do all of the following before ingesting, saving synthesis, or
linting:

1. Read `SCHEMA.md`.
2. Read `index.md`.
3. Read the last 20–30 entries of `log.md`.
4. For a wiki with 100 or more Global content pages, search Global Markdown files
   for the task's main terms; include relevant `notes/` materials when needed.

Do not create or update pages until orientation is complete. The local
`SCHEMA.md` overrides generic rules in this skill when the two differ.

If the expected files do not exist, determine whether the user wants a new wiki
initialized. Do not silently initialize one during an unrelated task.

## Non-Negotiable Invariants

- Never modify the body of an existing file under `raw/`. Frontmatter-only
  metadata repair is allowed when the body remains byte-for-byte unchanged.
- Every Global synthesized page has valid YAML frontmatter.
- Every new Global synthesized page is listed in root `index.md`; learning and
  research materials are navigated through `notes/index.md`.
- Append knowledge writes and maintenance operations to root `log.md`.
- Use only tags declared by `SCHEMA.md` on Global synthesized pages; add a needed
  tag to the taxonomy first.
- New and materially updated Global synthesized pages should have at least two
  meaningful outbound `[[wikilinks]]`; add useful backlinks where appropriate.
- Bump `updated` whenever page content changes.
- Preserve genuine unresolved source conflicts; correct demonstrated synthesis
  errors and retain their history in the log, not as competing facts.
- Verify changed knowledge claims against their actual evidence before saving.
  A citation, an inference label, or high confidence does not establish truth.
- Ask before an ingest that would update 10 or more existing synthesized pages.
- Follow the page thresholds in `SCHEMA.md`; do not create pages for passing
  mentions.

## Initialize a Wiki

When asked to create a wiki:

1. Resolve or confirm the path.
2. Ask for a specific domain if it is not already clear.
3. Create the directory structure shown above, including `notes/`.
4. Customize `SCHEMA.md` for that domain, including a controlled tag taxonomy
   and the synthesis/material boundary.
5. Create `index.md`, `log.md`, and `notes/index.md`.
6. Record the initialization in the log.
7. Report the path and suggest useful first sources.

Use [templates.md](templates.md) as the starting point.
Do not copy placeholder text unchanged.

## Ingest Sources

### 1. Capture

Capture each source in the appropriate `raw/` subdirectory:

- Web article or clipping → `raw/articles/`
- Paper or PDF → `raw/papers/`
- GitHub repository → `raw/repositories/`
- Pasted interview, meeting, or spoken text → `raw/transcripts/`
- Referenced image or diagram → `raw/assets/`

Use a descriptive lowercase, hyphenated filename. Store Markdown when possible.
Use the available web/PDF extraction tool for URLs and PDFs; preserve the
extracted source rather than a summary as the raw body.
Each textual raw source starts with:

```yaml
---
source_url: https://example.com/source
ingested: YYYY-MM-DD
sha256: <SHA-256 of the exact body after the closing delimiter>
---
```

For a source without a URL, omit `source_url` or use the source identifier
defined by the local schema.

#### Raw Immutability and Metadata Repair

The body begins after the first closing `---` and is immutable. During ingest
and re-ingest, validate the involved raw files; during lint, validate all raw
files. Automatically repair unambiguous source metadata, capture, importer-equivalent
(for example `source` → `source_url`), and `sha256` fields without asking.

Repairs must stay in frontmatter. Verify before and after that the body is
byte-for-byte unchanged and the declared hash matches; otherwise report the
problem without guessing. Never put interpretation in raw metadata. Log repairs.
Do not replace a mismatched hash merely with the current file's hash to make lint
pass; establish the intended bytes from the recorded revision or capture first.

A human-supplied body replacement is a new capture: keep its body, repair its
metadata, and re-run synthesis. Agent re-ingestion must preserve the old body in
a dated or versioned file.

Before re-ingesting a URL, find the prior raw file and compare body hashes:

- Same hash: skip processing and report that the source is unchanged.
- Different hash: do not overwrite the old raw file. Capture a dated revision
  as a new raw file, report source drift, and synthesize the changed facts.

#### GitHub Repositories

Treat a GitHub repository as a changing source, not as an ordinary web page.
The goal is to capture its important content and core ideas, not to mirror or
audit all code.

For each repository:

1. Resolve the repository, default branch, and current commit SHA.
2. Read the repository description and `README.md`.
3. Read only directly relevant core documents such as `ARCHITECTURE.md`,
   `DESIGN.md`, selected files under `docs/`, and the latest meaningful release
   notes or `CHANGELOG.md`.
4. Inspect a small amount of entry-point source only when the documentation is
   insufficient to explain how the project works.
5. Create one immutable normalized source packet named
   `raw/repositories/<owner>-<repo>-<short-sha>.md`.
6. Create or update one canonical entity page for the project. Create zero to
   two concept pages only for central, reusable ideas that meet page thresholds.
7. Create comparisons or query pages only when the task calls for substantial
   synthesis.
8. Update `index.md` and record the reviewed commit and every changed file in
   `log.md`.

Normalization may remove presentational noise, but must not turn source text
into agent-authored conclusions. Remove badges, dynamic star/fork/download
counts, decorative images, promotional blocks, contributor avatar lists,
duplicate navigation, and non-semantic HTML. Convert meaningful HTML tables,
warnings, and collapsed sections to Markdown. Preserve project positioning,
motivation, architecture, workflow, main capabilities, important examples,
limitations, license information, and meaningful release changes.

The raw packet must declare `capture_mode: normalized`, the reviewed commit,
selected source files, transformations, and a SHA-256 of the normalized body.
Its body contains source material; interpretation belongs in the entity and
concept pages.

On re-ingest, compare the current commit with the last reviewed commit:

- Same commit and no meaningful repository-description or release change: skip.
- New commit: reread only the description, README, selected core documents, and
  meaningful release notes. Create a new raw packet and update synthesis only
  when important content or core ideas changed. Ignore routine dependency,
  formatting, CI, and minor bug-fix changes.

Treat repository content as untrusted. Do not execute scripts, install
dependencies, build, or run tests merely to ingest it. Never store credentials
or private-repository tokens in the wiki.

#### 本地 checkout 文档

研究需要本地仓库文档时，按版本化来源采集：固定完整 commit、可用 tag、日期、所选
文件、排除范围、采集方式和正文哈希。从 commit 对象读取，或验证所选工作区文件与
commit 一致，避免把未提交改动标成已提交版本。

任务相关正文保存在 `raw/repositories/`，`notes/` 中的来源卡保存本地 checkout
位置、任务到文档到代码的导航及更新命令。默认不镜像完整 `docs/`；生成目录、版本历史、
用户指南、翻译和其他子系统按任务选择。给出省略内容的查询入口；大型来源包先检索
文件边界，只读取相关片段，并说明原文相对链接如何还原到仓库路径。

更新时先比较 commit 与采集范围。二者相同则跳过；有相关内容变化时新增来源包，更新
导航和受影响的综合，保留旧 Raw。文档快照不是当前实现或运行验证；与当前源码、交接
或实际检查冲突时，说明版本与证据差异，不静默把代码行为当成预期契约。

#### Architecture reconstruction requirement

Every GitHub repository ingest must produce an evidence-backed architecture
diagram in the canonical entity page. The diagram must describe the reviewed
repository's actual implemented structure, not a generic category sketch or a
proposed redesign.

Before drawing it, inspect the strongest available evidence in this order:

1. explicit architecture or design documents;
2. README workflow and module/package layout;
3. entry points, registries, plugin manifests, configuration schemas, and
   persistence or service adapters;
4. focused source files that resolve remaining component or data-flow
   uncertainty.

Use an Obsidian-readable Mermaid `flowchart` or `sequenceDiagram` in the entity
page. Prefer a vertical overview, short labels, and one explanatory question per
diagram. The overview normally has about 8–12 nodes, but this is a readability
target, not a deletion quota. Show the caller or entry point, major internal
components and ownership boundaries, primary data/control flow, external
services or storage, extension seams, and durable state when the repository
implements them.

Also retain **identity-bearing components**: evidenced parts that distinguish the
project from a generic member of its category, even when they are not on the
main synchronous execution path. Examples include a domain ontology, AI context
layer, policy model, compatibility-preservation mechanism, or distinctive
state projection. If the overview becomes crowded, move secondary mechanisms
to a focused diagram or adjacent prose; never delete important information only
to meet a node count. A useful check is to hide the project name and ask whether
the diagram still explains what makes this system different.

Before drawing, build an **Architecture Coverage Ledger** from the reviewed
evidence. List the important components, established relationships, state and
ownership, external dependencies, trust boundaries, identity-bearing
mechanisms, and maturity limitations. After drawing, assign every ledger item
to the overview, a focused diagram, adjacent prose, an optional reader-facing
table, or an explicit evidence-based omission. An item must not disappear merely
because the visual layout was simplified. The ledger is an internal quality
check and does not appear in the synthesized page by default.

Publish a compact table only when details omitted from the diagrams affect use,
validation, security, compatibility, or maturity **and** adjacent prose does not
already explain them clearly. Give it a reader-facing title such as `关键实现与
边界` or `运行时与信任边界`, not the process-oriented title `架构覆盖表`.
Do not duplicate diagram nodes, later sections, ordinary feature lists, or every
source file.

Do not add a fixed evidence note beneath a diagram. Preserve source attribution through
the page `sources` frontmatter, the normalized raw packet, and the reviewed
commit in the page's source section. Do not repeat the packet's selected path
list in the reading flow. After each diagram or coherent diagram group, add
three to five steps explaining its flow and boundaries. Keep a diagram-specific
uncertainty, maturity limit, or implementation caveat in adjacent prose only
when it changes how the reader should interpret the diagram.

Use arrows only when the selected evidence establishes the relationship. If the
evidence cannot establish a component or connection, omit it or label it as
unresolved; never infer it from a project name, dependency list, marketing
claim, or familiar architecture pattern. If the repository is too small or the
available evidence is insufficient, write a bounded “架构证据不足” note instead
of fabricating a complete diagram.

The diagram is agent-authored synthesis and belongs in the canonical entity page.
The Raw packet may preserve source diagrams or architecture descriptions, but
must not present an inferred diagram as source text.

Use the full rules and templates in
[github-repositories.md](github-repositories.md).

### 2. Discuss

In interactive work, briefly discuss the source's important takeaways and what
matters for the wiki domain. In explicitly automated or scheduled work, proceed
without waiting.

### 3. Reconcile

Search `index.md` and the wiki for entities, concepts, and claims from the
source. Prefer updating a canonical page over creating a near-duplicate.

Create a page only when its subject:

- appears in two or more sources, or
- is central to one source and important to the wiki's domain.

### 4. Synthesize

Before adding or changing knowledge claims, read
[factual-verification.md](factual-verification.md).
It covers source entailment, definitions and algorithms, current facts, and
correction propagation. Verify the changed claims and their dependencies; a
formatting-only edit does not require a new factual audit.

Before drafting, reduce the source to an explanatory model:

1. **Problem:** What recurring problem or tension is the subject responding to?
2. **Constraints:** What facts, costs, or invariants make the problem difficult?
3. **Mechanism:** What causal sequence turns the proposed idea into an outcome?
4. **Trade-offs:** What does the approach gain, sacrifice, or move elsewhere?
5. **Boundary:** Under what conditions does it fail, become unnecessary, or
   require a different approach?
6. **Transfer:** Which part is reusable beyond this source, and what would a
   concrete application in another context look like?

Do not merely rename the source's sections or feature list. Distinguish:

- **observed facts** stated or implemented by the source;
- **source claims** made by its authors;
- **agent inference** derived from the evidence;
- **transferable principles** that survive after source-specific names are
  removed.

Call an idea a first principle only when the page identifies the underlying
constraint and shows how the design follows from it. A slogan, project-specific
abstraction, or unsupported generalization is not a first principle.

For each new or updated page:

- Follow its existing structure or the page guidance in `SCHEMA.md`.
- Start with a short intuitive explanation before introducing architecture,
  terminology, or implementation detail.
- Prefer a causal chain, small worked example, or decision rule over a list of
  capabilities. Use an analogy only when its useful correspondence and limit
  are both clear.
- Introduce specialized English terms with a plain Chinese explanation on first
  use; avoid unexplained noun stacks and excessive capitalization.
- For a central concept, include at least one concrete transfer example and one
  boundary or counterexample. Mark hypothetical examples as such.
- After a complex diagram, explain in three to five steps how to read its main
  flow and why the boundaries matter. A diagram does not replace prose.
- Update facts, dates, relationships, open questions, and source lists.
- Add useful cross-links and backlinks.
- Use only taxonomy tags.
- Set `confidence: medium` or `low` for single-source, opinion-heavy, uncertain,
  or fast-moving claims. Use `high` only when the central claims have strong,
  independent support; repeated summaries of one source are not corroboration.
- Attach evidence to source-specific or decision-critical claims regardless of
  source count. Raw markers such as `^[raw/articles/source-file.md]` must support
  the adjacent claim and also appear in frontmatter `sources`. External checks
  need direct citations with the relevant version or verification date.

Create a standalone concept page only when its mechanism is reusable beyond the
originating source. Keep source-specific terminology on the entity page when it
cannot yet support a meaningful transfer example.

Use the full synthesis method and quality check in
[synthesis-quality.md](synthesis-quality.md). The
recommended headings are prompts for reasoning, not a rigid form: combine or
omit sections when doing so makes the explanation clearer.

When information appears to conflict, first distinguish a synthesis mistake or
different scope/version from a genuine unresolved disagreement. Correct the
former with evidence. For a genuine conflict:

1. Check publication and effective dates.
2. State both claims with their dates and sources when the conflict is real.
3. Set `contested: true`.
4. Add relevant slugs to `contradictions`.
5. Call out the unresolved issue in the result.

### 5. Update Navigation and History

After synthesis:

- Add new pages to the correct `index.md` section alphabetically.
- Search for the changed claim and synonyms in related Global pages, comparisons,
  queries, and index summaries; update affected statements within task scope.
  Check linked learning materials for stale duplicates; report findings outside scope.
- Update the index's date and total page count.
- Append one ingest entry to `log.md`, listing every created or updated file.
- Run `python3 .agents/scripts/check-wiki.py --root <resolved-wiki-root>` and
  review the final diff. Report structural checks separately from the factual
  claims and counterexamples actually checked; never equate a clean lint with
  a factually correct wiki.

For a batch ingest, read all sources first, reconcile all subjects in one search
pass, synthesize in one pass, and update the index and log once.

### 6. Report What Changed

List every file created or updated and summarize the knowledge-level changes for
the user.

## Learning and Research Materials

Use `notes/` for chapter notes, exercises, reading guides and versioned investigations.
Follow the material boundary in `SCHEMA.md`. Maintain topic navigation as needed;
do not create project status, progress tracking, profiles or promotion workflows.
Reusable findings follow the ordinary evidence-checking and synthesis steps above.
Engineering plans and handoffs belong in the relevant code repository.

## Save Query Results

按 [query.md](query.md) 检索并判断是否保存，遵循本库 `SCHEMA.md` 的策略或会话
授权。已获授权时在本轮完成保存；用户明确只读的要求优先。写入前完成上文的库
规则与历史定位，并执行综合与事实核验流程。

先与已有知识归属页核对，优先更新已有页面。只有具有跨项目价值、重新推导成本
较高的实质综合才新建全局 `queries/` 或 `comparisons/` 页面。仅服务当前目标的
研究细节可存入 `notes/`；工程计划与状态留在对应代码仓库。建议和待验证假设不能
写成已实现或已采纳的事实。按入库规则只补充支持本次结论所需的新来源。

同步相关导航与日期，将实际写入追加到规定的日志，并执行适用检查。纯查找和
没有内容变化的重复结果不写日志。答复给出实际保存页面的链接；实质综合或用户
要求保存的结果未落库时，说明具体原因。

## Lint the Wiki

Audit programmatically where practical, then inspect semantic findings.
Start with `python3 .agents/scripts/check-wiki.py --root <resolved-wiki-root>`.
It is read-only and checks structure, Raw hashes, inline Raw source registration,
and known placeholder contamination. It does not establish citation entailment,
algorithm correctness, current product behavior, or complete the manual checks
below. For a content audit or factual repair, use
[factual-verification.md](factual-verification.md) and
state which pages and claims were actually reviewed.
When changing the checker, run `python3 .agents/scripts/test_check_wiki.py`;
its temporary Wiki fixtures verify failures, code-example exclusions, and
read-only behavior.

Materials under `notes/` are excluded from Global page counts, taxonomy and orphan
requirements. Check their wikilinks, relative Markdown file links and material-index
navigation. No Project registration or lifecycle checks apply.

Check:

1. **Broken links:** every in-scope `[[wikilink]]` resolves to an existing
   synthesized, material, or raw Markdown target, or to an explicitly supported
   anchor/alias.
2. **Orphans:** every Global synthesized page has an inbound wikilink from another
   Global synthesized page.
3. **Index completeness:** every Global synthesized page appears exactly once in
   root `index.md`, and every root index target exists. Material topic entries
   resolve through `notes/index.md`.
4. **Frontmatter:** `title`, `created`, `updated`, `type`, `tags`, and `sources`
   exist and have valid values.
5. **Tag taxonomy:** every used tag is declared in `SCHEMA.md`.
6. **Staleness:** a page is older than a newer source that discusses its subject,
   using 90 days as the default warning threshold.
7. **Contradictions:** surface `contested: true`, `contradictions`, and apparently
   conflicting claims on closely related pages.
8. **Quality signals:** surface `confidence: low` and single-source pages without
   a confidence field.
9. **Raw integrity and metadata:** apply the automatic repair rules above;
   report ambiguous source metadata and unexplained hash mismatches.
10. **Page size:** flag synthesized pages longer than about 200 lines.
11. **Log size:** rotate after 500 entries.
12. **Citation registration and contamination:** inline Raw citations exist and
    are in the page's `sources`; synthesized prose contains no unresolved
    anonymization or extraction placeholders. Inspect excluded code examples
    manually if they are intended to be executable.

Group findings by severity:

1. broken links and invalid/missing required metadata,
2. index errors and orphans,
3. raw integrity drift,
4. contradictions and low-confidence claims,
5. stale, oversized, and style issues.

Include specific file paths and actionable fixes. Append:

```text
## [YYYY-MM-DD] lint | N issues found
```

Count concrete findings consistently and include the count in the report.

## Archive and Scale

When Global synthesized content is fully superseded:

1. Create `_archive/` if it does not exist.
2. Move the page to `_archive/<original-path>`.
3. Remove it from root `index.md`.
4. Replace inbound links with plain text marked `(archived)` or with the current
   canonical page.
5. Log the archive action.

When an index section exceeds 50 entries, split it by first letter or subdomain.
When the index exceeds 200 entries, create `_meta/topic-map.md` grouped by theme.
When `log.md` exceeds 500 entries, rotate it to `log-YYYY.md` and start a new
`log.md` that links to the archive.

## Obsidian Compatibility

Keep standard `[[wikilinks]]`, YAML frontmatter, and `![[asset-name]]` embeds so
the directory works as an Obsidian vault. Recommend `raw/assets/` as Obsidian's
attachment directory. Do not require Obsidian or its plugins for core wiki
operations.

For desktop use, Wikilinks work without plugins. Dataview is optional and useful
for frontmatter-based tables and filters.

## Alternative Compiler

[`llm-wiki-compiler`](https://github.com/atomicmemory/llm-wiki-compiler) is a
Node.js CLI inspired by the same pattern. It owns page generation and is tuned
for small corpora. Prefer this skill when human-directed, agent-in-the-loop
curation matters; consider the compiler when the user explicitly wants a
scheduled batch compilation pipeline.
