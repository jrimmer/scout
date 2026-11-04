# The session index: design

Status: proposed, for Scout 2.0 (branch `v2/session-index`). [session-querying.md](session-querying.md) says what we
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

**Outcomes** are derived, not stored: a thread's outcome is computed from its links (merged and held, merged then
fixed or reverted, closed unmerged, still open, no pull request). Rework and reverts are the useful ones; merge rate
only says whether people accepted a change.

## Sources and the crawler

```ts
type Page = { docs: Doc[]; links?: Link[]; cursor: string };

type Source = {
  name: string;                                                    // "slack", "forge", later "buildkite"…
  crawl(cursor: string | undefined, signal: AbortSignal): AsyncIterable<Page>;  // what changed since; undefined is a backfill
};
```

- The crawler runs each source on its own interval, pages through `crawl`, hands every page to `index.put`, and saves
  the cursor only after the page is stored. Delivery is at-least-once; `put` is idempotent, so a crash repeats work and
  nothing else.
- Failures back off per source, are logged once, and show on the dashboard and in `npm run doctor`. One source being
  down never blocks another.
- **Slack** also pushes live: `bridge.ts` calls the same `index.put` when a message arrives or a run ends, so threads are
  searchable at once. The crawler's Slack pass reconciles and backfills from Pi Durable's conversation entries (the
  path `reflect.ts` already uses), including `tool` documents.
- **The code host** crawls pull requests, reviews, review comments and issues for the repositories Scout is configured
  for, by `updated` time, and extracts links from descriptions and commit messages (`Fixes #12`, `Reverts #40`).
- A future source supplies the same thing: an `id` scheme, documents, links to what they concern (a build to its
  commit and pull request), and a cursor. Credentials stay with the host process, as they do for the code host today;
  a source never runs in a workspace.
- **Retention** is per source and per document: `SCOUT_RETENTION_DAYS` removes a thread's documents, chunks and
  links, as it removes its search entries now.

## The query interface

```ts
index.search({ text?, person?, repo?, source?, kind?, since?, until?, mode?, limit? }): Hit[]   // one hit per thread or document
index.read({ thread } | { id }, { budget }): Transcript                                         // the whole thing, clipped to a budget
index.outcome(thread): Outcome
index.stats(): per-source counts, newest document, cursor lag
```

Filters narrow first (person, repo, date are indexed columns on `documents`); ranking runs on what is left. Scout's
tools, all through this:

- `search_history`: replaces `search_threads`, with the filters above.
- `read_history`: whole threads by person, repo or date, redacted and capped; this is the one that lets Scout describe
  how someone works from examples rather than snippets.
- `repo_activity`: threads, pull requests, review rounds and outcomes for a repository over a period.

**Who may ask** is checked in the tool, from the asker's identity: `public` lets anyone, `admin` only members of the
admins group in `roles.json`. Answers quote and describe; they don't rank or score people (profile guidance, not code).

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
may not be visible to everyone in the workspace. Rule: a document from a repository comes back only to a thread in a
channel that may use that repository, the same rule that already decides where Scout works on it. Open question below.

## Order of work

Step 1 is built: `src/history.ts`, with `npm run bench:history` for the targets above (100,000 chunks: about 8,000
ingested a second, search at the 95th percentile 14 ms, with a person and a repository 3 ms).

1. **People and the store** (done). Record the Slack user id; create `index.sqlite` with documents, chunks, links, people and
   cursors; `put`, `search`, `read`, `forget`; backfill from `thread_text`. Tests, and the benchmark.
   *Done when:* `search_threads`' behaviour is reproduced by the new interface and the benchmark meets its targets.
2. **Sources and the crawler.** The `Source` type, the crawler loop with cursors and backoff, the Slack source (live and
   backfill, including `tool` documents), health in the dashboard and doctor.
   *Done when:* killing Scout mid-crawl and starting it again loses and duplicates nothing.
3. **The code host source and links.** Pull requests, reviews, issues, and `outcome()`.
   *Done when:* a thread whose pull request was later reverted reports that.
4. **Tools and the setting.** `search_history`, `read_history`, `repo_activity`, `SCOUT_HISTORY_ASK`, profile guidance,
   docs.
   *Done when:* "how does <person> work?" is answered from their threads on vm1, and `admin` mode refuses a non-admin.
5. **The embeddings gate.** The eval set, the embedding client, hybrid retrieval behind a setting; ship it or don't, by
   the gate.

## Open questions

- Which embedding model on LunaRoute, and does the gateway serve `/embeddings` the standard way (unverified).
- The private repository rule above: is "channel may use the repository" the right test?
- How much of a `tool` document to keep: names and clipped arguments and results, or only the names.
- The crawl interval per source (start at five minutes for the code host).
