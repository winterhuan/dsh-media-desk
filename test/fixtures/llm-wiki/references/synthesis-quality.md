# Synthesis for Understanding

Use this guide for agent-authored entity, concept, comparison, and substantial
query pages. The purpose is to compile source material into a model a reader can
reason with, not to produce a polished inventory of what the source said.

Before building that model, apply [factual-verification.md](factual-verification.md)
to the claims being added or changed. Explanation quality cannot substitute for
evidence; when the source does not establish a mechanism, retain an attributed
claim or uncertainty rather than completing the causal chain from intuition.

## Reader Outcome

After reading a canonical page, a reader should be able to answer:

1. What problem is this about?
2. Why is the problem hard?
3. By what mechanism does the idea or system change the outcome?
4. What does it trade away or leave unresolved?
5. When should I use this idea, and when should I not?
6. What nearby problem can I now reason about differently?

If the page only supports “what components or features exist,” it is not yet a
useful synthesis.

## Build the Explanatory Model

### 1. Find the tension

State the recurring conflict in ordinary language. Good tensions have two sides,
for example:

- more context improves recall, but increases cost and distraction;
- durable autonomy requires persistent state, but stale state can mislead;
- flexible model-side code improves composition, but expands the trust boundary.

Avoid starting with the project's own vocabulary. First establish the problem
that would still exist if the project disappeared.

### 2. Identify constraints

Separate hard constraints from chosen design assumptions:

- physical or computational limits;
- coordination and ownership boundaries;
- security and permission boundaries;
- economic costs;
- human attention or comprehension limits;
- assumptions made by this particular source.

This is the basis for first-principles reasoning. Do not call a claim
“first-principles” merely because it sounds fundamental.

### 3. Write the causal mechanism

Express the core as a short chain:

```text
constraint
→ design choice
→ changed behavior
→ desired outcome
→ new cost or failure mode
```

Every arrow should be explainable. If the evidence only establishes correlation
or an author claim, say so rather than presenting causation as fact.

### 4. Ground it

Add the smallest concrete example that makes the mechanism visible. Prefer an
example with:

- an initial state;
- one decision or transition;
- the resulting state;
- the reason the outcome differs.

Source-backed examples should name their source. Invented examples must be
marked “假设示例” and should illustrate rather than prove the claim.

### 5. Test the boundary

Include a failure condition, counterexample, or unnecessary-use case. Useful
knowledge includes the shape of its invalidity.

Ask:

- Which assumption can fail?
- Which cost grows nonlinearly?
- What simpler approach wins at small scale?
- What must remain outside this abstraction?
- What evidence would change the conclusion?

### 6. Transfer the principle

Remove product names and ask what remains. A transferable principle should be
expressible as a decision rule, such as:

> When execution state is expensive or unsafe to reconstruct, preserve a
> versioned state boundary and reconnect replaceable compute to it.

Then show one adjacent application and explain the mapping. Do not claim
universality from one project. If no honest transfer example exists, keep the
idea inside its entity page rather than creating a concept page.

## Progressive Disclosure

Prefer this reading order:

1. **核心认识:** one or two plain-language sentences that state the central understanding.
2. **要解决的问题:** tension and stakes.
3. **核心机制:** causal chain and only the terminology needed to explain it.
4. **具体例子:** one worked flow.
5. **边界与代价:** failure conditions and trade-offs.
6. **可迁移的认识:** reusable decision rule and adjacent application.
7. **实现与证据:** architecture, detailed facts, versions, and sources.

This is not a mandatory heading list. For a short page, several items may share
one section. Put definitions before acronyms and intuition before component
detail.

## Entity Pages

An entity page should answer both “what is this?” and “what can it teach us?”

- Describe the project in terms of the user problem before listing its internal
  nouns.
- Explain the architecture as responsibility boundaries and state transitions,
  not only boxes and arrows.
- After a diagram, narrate the main path in three to five numbered steps.
- Separate implemented facts, project claims, and agent inference.
- End with one to three lessons that remain useful if the project is replaced.
- Keep project-specific features on the entity page unless they reveal a
  reusable mechanism.

## Concept Pages

A concept page is not a renamed project feature. It should:

- have a source-independent definition;
- derive the mechanism from constraints;
- include a concrete example;
- state at least one boundary or counterexample;
- connect to at least one other setting where the same mechanism applies;
- distinguish a durable principle from one implementation.

## Comparison and Query Pages

Compare causal models and decision conditions, not feature counts. Conclude with
a conditional rule:

```text
Choose A when ...
Choose B when ...
Neither is sufficient when ...
```

For substantial queries, show the reasoning path and uncertainty rather than
only a final recommendation.

## Compression Rules

- One strong example is better than five shallow examples.
- One causal chain is better than a long feature list.
- Define a term once; afterwards use the shortest precise name.
- Delete paragraphs that repeat a heading without adding mechanism or evidence.
- Prefer tables for contrasts, prose for causality, and diagrams for topology.
- A page may be shorter than the source. It must not be harder to understand.

## Final Comprehension Check

Before saving, verify:

- [ ] The opening can be understood without knowing the source's vocabulary.
- [ ] The page names the problem and at least one real constraint.
- [ ] The core mechanism is causal, not a capability list.
- [ ] Facts, source claims, and inference are distinguishable.
- [ ] Changed central claims are supported by the cited passages and retain
      their scope, version, and quantifiers; citations are registered.
- [ ] A concrete example makes the mechanism observable.
- [ ] A boundary, failure mode, or counterexample is present.
- [ ] Changed guarantees or algorithm steps survive the relevant boundary
      checks; hypothetical examples are not treated as proofs.
- [ ] A reusable concept has a genuine transfer example.
- [ ] Diagrams have a prose reading path.
- [ ] The reader can derive a decision rule or a new question.
- [ ] Removing source-specific names leaves a coherent insight.
- [ ] Related summaries and evidence-limit statements still match the page.
