# The session index: design

Status: steps 1 to 4 built, step 5 (embeddings) open; for Scout 2.0 (branch `v2/session-index`). [session-querying.md](session-querying.md) says what we
want to ask; this says how Scout will know enough to answer, and in what order it gets built.

## What it is

One store of everything people and systems have said and done around Scout's work, a crawler that keeps it current from
any number of sources, and one query interface that Scout's own tools use. The first sources are Slack threads and the
code host (pull requests, reviews, issues). Later ones (Buildkite, AWS, others) are added by writing a source, without
touching the store or the tools.

Not goals: a UI, ranking or scoring people, indexing private places (Scout only works in public), or a general search
product. Scout 1's `search_threads` is replaced by this, not kept beside it.

## Principles

- **One writer, one reader.** Sources produce documents; only the index writes them. Tools read through the query
  interface, never the tables.
- **Sources are adapters.** A source knows how to ask its system what changed. It knows nothing about storage,
  chunking, redaction or retention.
- **Public by default.** Anyone may ask about anyone's public work. A setting (`SCOUT_HISTORY_ASK`, `public` or `admin`,
  default `public`) says who may ask. There is no per-person opt-out.
- **Redact on the way in.** Text passes `scan.ts` before it is stored, as today.
- **Measure before adding.** Embeddings join retrieval only if they beat plain full-text search on real questions.
- **Keep it small.** The source interface exists because there are two real sources at once (Slack and the code host).
  Nothing is built for Buildkite or AWS until one is wanted; the interface just has to make them possible.

## The data

Tables (`history_*`) in `scout.sqlite`, like every other store of Scout's, so the backups already cover them. If vectors make the file too large to back up with the rest, they move to a file of their own.

- **documents**: `id` (`source:kind:ref`), `source`, `kind`, `repo`, `thread` (Scout's conversation, if any), `author`
  (a stable person id), `at`, `title`, `url`, `parent`, `hash`, `meta` (JSON). Kinds so far: `message`, `pull`,
  `review`, `comment`, `issue`, `tool` (a summary of a tool call). A document's identity is what makes re-crawling safe:
  the same `id` with the same `hash` is skipped; a changed `hash` replaces it.
- **chunks**: `doc`, `seq`, `text`; an FTS5 table over `text` (Porter stemming as now). A chunk is a whole message
  or description, or about 800 tokens with overlap for long text. A chunk's id is its row in the full-text table.
  Embeddings (stage 2) go in a table of their own keyed by chunk id, with the model's name and dimension.
  Who, where and what (person, repository, source, kind) are tags in the full-text row, so a search for one person's
  threads is part of the full-text query, not a filter applied to its results; that is what keeps filtered search fast.
- **links**: `from`, `to`, `rel`, `at`, `source`. Relations: `opened` (thread to pull), `closes` (pull to issue),
  `mentions`, `fixes`, `reverts`, `builds_on`, `touches` (a later pull changes files of an earlier one soon after it
  merged). This is where outcomes come from.
- **people**: Slack user id, display names over time, code host logins, from the people file. This is what joins a
  Slack author to a pull request author. Today the index stores only a display name (`bridge.ts`), so the first step is
  recording the id and backfilling it from the threads table and the audit log.
- **cursors**: `source`, `scope`, `value`, `updated`. Where each crawl stopped.

**Outcomes** are derived, not stored: `history.outcome(thread)` computes a thread's from its links, one verdict per pull
request and the worst of them overall: `reverted`, `fixed` (a later pull request says it fixes it), `closed` (unmerged),
`open`, `merged` (too soon to say), `held` (merged 14 days ago with neither of those), or `none`. Rework and reverts are the useful ones; merge rate
only says whether people accepted a change.

## Sources and the crawler

```ts
type Page = { docs: Doc[]; links?: Link[]; cursor: string };

type Source = {
  name: string;                                                    // "slack", "forge", later "buildkite"…
  scopes?(): string[] | Promise<string[]>;                         // what to crawl separately: a repository, a project (default: one)
  crawl(scope: string, cursor: string | undefined, signal: AbortSignal): AsyncIterable<Page>;  // what changed since; undefined is a backfill
  everyMs?: number;                                                // its own interval, if not the crawler's
};
```

- The crawler runs on the service's housekeeping tick (every five minutes) and takes each source on its own interval. It pages through `crawl` and hands every page to the store, which writes the page, its links
  and the cursor in one transaction. Delivery is at-least-once; `put` is idempotent, so a crash repeats work and
  nothing else.
- Failures back off per source (the interval doubles, up to an hour), are logged once, and are reported through the service's health. One source being
  down never blocks another.
- **Slack** also pushes live: `bridge.ts` calls the same `history.put` when a message arrives or a run ends, so threads are
  searchable at once. The crawler's Slack pass reconciles and backfills from Pi Durable's conversation entries (the
  path `reflect.ts` already uses), including `tool` documents. Those stay out of ordinary searches and come back only when a search asks for `kind: tool`, since a command's output is noise next to what people said.
- **The code host** (`src/source-forge.ts`) crawls the repositories Scout is configured for, one scope each, by
  `updated` time: pull requests and issues (any state), and what was said on them (comments, review summaries, comments
  on lines). A first crawl goes back 180 days, not to the beginning. Documents are `forge:item:<repo>#<n>` (kind `pull`
  or `issue`, with `state`, `mergedAt` and `closedAt` as document facts) and `forge:remark:<repo>#<n>:<id>`
  (kind `review` or `comment`, with the verdict, file and line). Links come from the title and description
  (`Fixes #12` is `closes`, `Reverts #40` or `Revert "… (#40)"` is `reverts`, "builds on #8" is `builds_on`, any other
  `#n` is `mentions`), and from a thread to each pull request Scout opened for it (`opened`).
  Left for later: commit messages as a link source, and `touches` (a later pull request changing the files of an
  earlier one soon after it merged), which needs the files of every merged pull request.
- A future source supplies the same thing: an `id` scheme, documents, links to what they concern (a build to its
  commit and pull request), and a cursor. Credentials stay with the host process, as they do for the code host today;
  a source never runs in a workspace.
- **Retention** is per source and per document: `SCOUT_RETENTION_DAYS` removes a thread's documents, chunks and
  links, as it removes its search entries now.

## The query interface

```ts
history.search({ text?, person?, repo?, source?, kind?, since?, until?, mode?, limit? }): Hit[]   // one hit per thread or document
history.read({ thread } | { id }, { budget }): Transcript                                         // the whole thing, clipped to a budget
history.outcome(thread): Outcome
history.stats(): per-source counts, newest document, cursor lag
```

Filters narrow first (person, repo, date are indexed columns on `documents`); ranking runs on what is left. Scout's
tools, all through this:

- `search_history`: replaces `search_threads`, with the filters above. `repo` means the repository's pull requests and
  issues and the threads in its channels (a Slack document doesn't know its repository, but its channel does).
- `read_history`: whole threads by person, repo or date, redacted and capped; this is the one that lets Scout describe
  how someone works from examples rather than snippets.
- `repo_activity`: threads, pull requests, review rounds and outcomes for a repository over a period. Counts, not scores.

**Who may ask** is checked in the tool, from the asker's identity: `public` lets anyone, `admin` only members of the
admins group in `roles.json` (those allowed to approve changes to everything). Plain search for earlier threads by topic
is open in both: it always was. Answers quote and describe; they don't rank or score people (profile guidance, not code).

## Retrieval

**Stage 1, full text.** FTS5 over chunks, bm25 with the title and text weighted, filters joined from `documents`,
results grouped to one per thread. No new dependency.

**Stage 2, hybrid, only if it earns its place.** Embeddings from an OpenAI-compatible `/embeddings` endpoint through the
gateway (LunaRoute serves several embedding models; which one, its dimension and its input limit are to be checked,
not assumed; `pi-ai` has no embeddings call, so this is a small client of our own). Vectors are stored on the chunks
with the model's name. Search embeds the question, scores the candidate set that the filters left by exact cosine
similarity, and fuses it with the full-text ranking (reciprocal rank fusion). Filters first means a scan over a small
set, so no vector index is needed until the corpus is far larger than ours; `sqlite-vec` stays an option, and
`loadExtension` works under `node:sqlite` here (to be confirmed on CT164's Node 24). Changing the model re-embeds in the
background; a query only uses chunks made by the current model.

**The gate.** Before Stage 2 ships, a set of at least 50 real questions drawn from Scout's own threads, each with the
threads that should be found, run through the existing evals framework ([evals.md](evals.md)). Hybrid ships if its recall
at 5 beats full text by a margin we set before looking (10 points to start); otherwise it stays off and the code
stays out.

**Performance targets**, measured on a synthetic corpus of 100,000 chunks and kept as a benchmark: full-text search
under 50 ms at the 95th percentile; hybrid under 250 ms excluding the embedding call; ingest above 500 chunks a second.

## Visibility

Scout only works in public channels, so Slack text is public. A private repository is different: a pull request there
may not be visible to everyone in the workspace. Rule: a document from a repository comes back only to a thread that may read
that repository's code (`readableRepos` in scout.ts: the repositories the person asking may ask for work in), and a thread
that may not is told so when it asks for that repository by name. Open question below.

## Order of work

Step 1 is built: `src/history.ts`, with `npm run bench:history` for the targets above (100,000 chunks: about 8,000
ingested a second, search at the 95th percentile 14 ms, with a person and a repository 3 ms).

1. **People and the store** (done). Record the Slack user id; create the `history_*` tables in `scout.sqlite` with documents, chunks, links, people and
   cursors; `put`, `search`, `read`, `forget`; backfill from `thread_text`. Tests, and the benchmark.
   *Done when:* `search_threads`' behaviour is reproduced by the new interface and the benchmark meets its targets.
2. **Sources and the crawler** (done: `src/crawler.ts`, `src/source-slack.ts`). The `Source` type, the crawler loop with cursors and backoff, the Slack source (live and
   backfill, including `tool` documents), health through the service.
   *Done when:* stopping Scout mid-crawl and starting it again loses and duplicates nothing (test/crawler.test.ts), and a live answer and its crawled copy are one document (test/e2e-history.test.ts).
3. **The code host source and links** (done: `src/source-forge.ts`, `History.outcome`). Pull requests, reviews, issues, and `outcome()`.
   *Done when:* a thread whose pull request was later reverted reports that (test/e2e-history.test.ts does it through the service).
   A code host login and a Slack user are one person once `linkLogins` has joined them (the lookup that already decides who
   may ask for work), so a person's pull requests and their threads are found together.
4. **Tools and the setting** (done: `src/history-tools.ts`, `SCOUT_HISTORY_ASK`). `search_history`, `read_history`, `repo_activity`, `SCOUT_HISTORY_ASK`, profile guidance,
   docs.
   *Done when:* "how does <person> work?" is answered from their threads on vm1 (not yet tried there: this branch isn't
   deployed), and `admin` mode refuses a non-admin (test/history-tools.test.ts).
5. **The embeddings gate** (harness built: `npm run eval:retrieval`, `test/retrieval-eval.ts`; nothing in `src/`). The eval set, the embedding client, hybrid retrieval behind a setting; ship it or don't, by
   the gate.

## Open questions

- Embeddings, checked 2026-11-04 against the gateway (llm.lacy.casa/v1, from CT164, no key): it serves `/v1/embeddings` the OpenAI way, and of its 20 models one is an embedding model, `local-embed//opt/llama-embed/nomic-embed-text.Q8.gguf`, 768 dimensions. It embeds about 3 chunks a second (137 chunks took 39 s), so a 100,000-chunk backfill would take most of a day: embedding has to be a slow background job, newest first, and a query can only use the chunks done so far. A question takes about 70 ms to embed and scan.
- ~~The private repository rule~~ Settled (Jason, 2026-11-04): private repository content only appears where the repository may be used. Built as "the repositories this thread may read code from" (the code search rule), which is the person asking, not just the channel.
- How much of a `tool` document to keep: names and clipped arguments and results, or only the names.
- The crawl interval per source (start at five minutes for the code host).

## The gate, as it stands

`npm run eval:retrieval -- --db <copy of scout.sqlite> --questions questions.json` embeds a copy's chunks, and for each question compares recall at 5 for words, meaning and the two fused. `--mine` lists each thread's first words, to write questions from. It runs, and on four invented questions over the vm1 copy words found all four and fusion changed nothing: that is a check of the harness and no evidence either way. The real gate needs at least 50 questions with the threads that answer them, written by people who asked or would ask them. Scout's own threads so far are mostly tests and alerts, so there are not yet enough real ones to write from; the set grows as people use it. Until then hybrid search stays unbuilt.
