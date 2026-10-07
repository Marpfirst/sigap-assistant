<div align="center">

# Sigap Assistant

**Two agents. One chat column. Every token accounted for.**

[![Built with Next.js 14](https://img.shields.io/badge/Next.js-14-000000?logo=next.js&logoColor=white)](https://nextjs.org)
[![Written in TypeScript 5](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Supabase with pgvector](https://img.shields.io/badge/Supabase-pgvector-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com)
![843 tokens per question](https://img.shields.io/badge/tokens%2Fquestion-843-informational)
![Golden set: 40 of 42 passing](https://img.shields.io/badge/golden%20set-40%2F42-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**[Live demo](https://rag-chatbot-marp.vercel.app)** ·
[Repository](https://github.com/Marpfirst/sigap-assistant)

</div>

---

## What this is

A small RAG chat application where a **Manager** agent handles general questions
and delegates document-grounded questions to a **Specialist** agent. The reader
sees one chat column; each answer shows which agent produced it and what it cost
in tokens.

The corpus is a fictional Indonesian helpdesk SaaS called Sigap — four documents,
38 sections. Fictional on purpose: the model cannot know Sigap's pricing from
training, so a correct answer proves retrieval worked rather than that the model
guessed well.

## Architecture

```
                  ┌─ answers directly ──────────────────────────► answer
User ── Manager ──┤
                  └─ search_docs ─► retrieval ─► Specialist ────► answer
                                                                    │
                                                              usage_log
```

**There is no separate classifier.** Routing happens inside the Manager's own
turn: it either returns an answer or emits a `search_docs` tool call. A
dedicated classification call would make every trivial question pay twice, in
tokens and in latency.

When nothing clears the similarity floor, the Specialist is skipped entirely and
the system replies "not in the documents" — so an out-of-corpus question is one
of the *cheapest* paths, not the most expensive.

## How the RAG works

**Chunking is structure-aware, not fixed-size.** `scripts/seed.ts` splits each
document at its `##` headings — one chunk per section, four documents into 38
chunks. The boundaries are the ones a human already wrote, so there is **no
overlap**: overlap exists to soften a boundary a chunker had to guess at, and
duplicating tokens into every retrieval to soften a heading would be paying for
nothing.

Each chunk is stored with a contextual header, `[Harga Sigap > Paket Tumbuh]`,
about 13 tokens that keep it unambiguous once it is pulled out of its document
and read alone. Its id is that same pair: `pricing#paket-tumbuh`.

**Embeddings** are `text-embedding-3-small`, 1536 dimensions, the same model for
the corpus and for queries. They live in Postgres via **Supabase pgvector**, and
`match_chunks` (in `supabase/schema.sql`) does the search in SQL: cosine
similarity, with both the similarity floor and the row limit applied inside the
query so rejected rows never leave the database.

There is **no ANN index**, deliberately. At 38 rows a sequential scan is
instant, and `ivfflat` needs far more rows before its lists mean anything.

| Setting | Value | Why |
|---|---|---|
| `MATCH_COUNT` | 5 | 3 and 4 were measured and both broke the same follow-up case |
| `MATCH_THRESHOLD` | 0.40 | calibrated from measured scores: in-corpus questions top out around 0.63-0.66, comparisons and follow-ups at 0.55-0.61, out-of-corpus ones at 0.44 |
| `EMBED_MODEL` | `text-embedding-3-small` | 1536-dim and cheap; at 38 chunks a larger model has nothing to resolve |
| `MODEL_MANAGER` / `MODEL_SPECIALIST` | `gpt-4o-mini` | see below |
| `HISTORY_TURNS` | 4 | measured against 2: both scored the same, but the value counts *messages*, so 2 is one exchange with no margin for a two-step follow-up |
| `MAX_TOKENS_MANAGER` / `_SPECIALIST` | 250 / 400 | a server-side ceiling, so one bad answer cannot run away with the budget |
| `RATE_LIMIT_PER_MIN` | 15 per client address | counted in `request_log`; fails open, because a broken limiter should not break the product it guards |

**Both agents use `gpt-4o-mini`, deliberately the same model.** The Specialist's
job is extraction from a context the Manager has already narrowed, not
reasoning, so the harder work is the routing decision rather than the answer. A
larger model was never adopted because accuracy was never the bottleneck —
every failure traced to routing or to the test set, not to the model's ability
to read a paragraph. Using one model for both also keeps the token comparison
between the two paths honest.

**What gets embedded is the question plus the Manager's rewrite**, not either
alone. The Manager rewrites "kapan WFH?" into a full Indonesian noun phrase
before searching — the raw abbreviation scores 0.370 and falls under the floor,
the phrase scores 0.787 against the same chunk. But the rewrite alone loses
named entities, and the question alone breaks follow-ups, so both are embedded
together for about five extra tokens.

The contextual header is part of what is embedded — it is what separates three
near-identical leave sections in vector space — but it is **stripped before the
Specialist reads the chunk**. By then the context is already narrowed, so
keeping it would be paying for the same disambiguation twice.

## Routing philosophy

| Question | Route |
|---|---|
| "Apa itu SLA?", "Apa itu API?" | Manager answers from general knowledge |
| "Apa itu Sigap?", "Berapa SLA P1?" | Specialist, grounded in the documents |
| "Buatkan puisi tentang laut." | One-sentence refusal |

The Manager handles general knowledge and conversation. The Specialist is the
source of truth for anything whose answer lives in the provided documents —
including what Sigap itself is, because that definition is in `product.md`.

Neither message length nor capitalisation is a routing criterion; only scope and
whether an internal fact is needed.

## Token accounting

Every API call's `usage` field is recorded — never estimated. `usage_log` stores
one row **per agent call**, not per answer, so the cost of delegating stays
visible instead of being hidden in a total. The chat UI shows the same number
next to each answer, and `/history` shows the stored rows.

## Evaluation

`eval/golden.jsonl` — 42 questions across seven categories: general, scope
boundary, document facts, two-section comparisons, absent-from-corpus,
out-of-domain, and history-dependent follow-ups.

| | Result |
|---|---|
| Golden set | **40/42** |
| Tokens per question | **843** |
| recall@k | **100%** |
| precision@k | **33%** |
| Naive baseline (historical, 18-question set) | 2,654 tokens |

**Why recall is 100%, and why that is not a free pass.** An earlier version of
this set was too easy: every question mapped to exactly one chunk, so `k=1`
passed all of it and looked like a saving. Adding two questions that genuinely
need two sections at once — comparing plan prices, comparing the attachment
limit against the export limit — broke `k=1` immediately. The set has been kept
hard since: it includes questions whose answer is deliberately absent from the
corpus, near-identical sections that must not be confused, and follow-ups that
only resolve against the conversation. 100% means the right section was
retrieved for every question that has one, on that set — not that retrieval is
solved.

**Why precision is only 33%, and why that is arithmetic rather than quality.**
Of the 15 questions with expected sections, 13 need exactly one and 2 need two.
With `k` fixed at 5, a single-answer question can score at most 0.20 however
perfect the ranking is, which puts the ceiling for this set at about 23%. The
measured 33% is *above* that, because the similarity floor frequently returns
fewer than five chunks. The real cost of a fixed `k` is the tokens, not the
precision figure.

**Where the 843 tokens go.** 591 of them are the Manager's system prompt — the
routing policy plus the document map — paid on every question, including one
that ends in a one-sentence refusal. That is the largest single line item by a
wide margin, and it is also the one that resisted compression: cutting it is
what produced the 694-token run that lost correctness.

The two failures are known and left unpatched rather than hidden:

- **"Apa itu reimbursement?"** can be declined. The term reads either as a
  general concept or as a request for the company's reimbursement policy, and
  the assignment does not define that boundary — so there is no answer key to
  claim. Adding a question-specific exception would make the router more
  brittle, which this project has already demonstrated once.
- **"wHaT iS sLa"** is declined while "WHAT IS SLA" is answered. Capitalisation
  is stated in the prompt as not being a routing criterion, and it does not hold
  for that alternating form.

`eval/results/` keeps three runs on purpose: the naive starting point, the final
result, and one rejected optimisation — prompt compression reached 694 tokens
but scored 32/34, which is why it was reverted. The engineering decisions behind
these numbers are written up in a separate one-page note, delivered alongside
this repository.

```bash
npm run eval     # the 42-question golden set
npm run repro    # one 8-turn conversation, for cross-turn consistency
npm run smoke    # provider check: tool calling, embeddings, honest usage
```

## Local setup

Requires Node 18+, a [Supabase](https://supabase.com) project, and an OpenAI API
key (or any OpenAI-compatible endpoint — see `.env.example`).

```bash
npm install
cp .env.example .env
```

Fill in three values; the rest ship with working defaults:

```bash
OPENAI_API_KEY=sk-...
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
```

Paste [`supabase/schema.sql`](supabase/schema.sql) into the Supabase SQL editor
and run it once — it creates the tables, the vector search function, and enables
row-level security with no policies, so nothing is reachable except through the
server.

```bash
npm run smoke    # verify the provider before spending anything
npm run seed     # chunk -> embed -> store
npm run dev
```

Open <http://localhost:3000>.

To deploy, import the repository on Vercel and set the same environment
variables. `NAIVE_MODE` must stay `false`, or visitors get the 2,654-token
baseline instead of the real system.

`vercel.json` pins the function to `sin1`. Vercel's default region is `iad1`
(Washington DC) while the Supabase project answers from Singapore, so every
dynamic render crossed the Pacific twice: the query itself takes 40-80 ms, but
the page took 683 ms. Pinned next to the database it is 150-250 ms. Change the
region if your Supabase project lives elsewhere — `curl -sI <url>/history` and
read `X-Vercel-Id`, which names the edge and the execution region.

## Project layout

```
app/                    chat UI, /history, /documents, POST /api/chat
components/             shell, answer renderer, document table, local time
lib/agents/             manager.ts (routing + general answers), specialist.ts
lib/                    retrieval, usage logging, history, db, llm, env
docs/id/                the four source documents
eval/                   golden.jsonl + three saved results
scripts/                seed, eval, repro, smoke
supabase/schema.sql     tables, match_chunks, RLS — a fresh install runs this alone
supabase/migrations/    later changes, for databases created before them
vercel.json             pins the function region next to the database
```

## License

[MIT](LICENSE) — © 2026 Alvin.

The corpus in `docs/id/` describes a fictional company. Any resemblance to a
real product named Sigap is coincidental.
