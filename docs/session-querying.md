# Session querying: learning from how people work with Scout

Everything said in Scout's threads is public, so everything in them can be read by anyone, and so by Scout on
someone's behalf. That turns the history into something to ask questions of: not only "has this come up before"
(`search_history` does that) but "how does this person work" and "how is this repository doing".

This page records what we want to be able to ask, and what each question needs. It is a design note, not a feature
list: [what exists today](#what-exists-today) says which parts are built.

## Where the idea comes from

Patrick Erichsen ([@patrickerichsen](https://x.com/patrickerichsen/status/2117699697163047045), of OpenClaw) described
what happened when his team moved to multiplayer sessions, where everyone can read each other's prompts. He was
hesitant at first ("I say a LOT of dumb things to my agent"), then found that everybody else does too, and that there
is a lot to learn from how teammates drive their agents. To learn how the team's UI/UX designer prototypes with agents,
he asked his own agent, which read the designer's sessions and described the workflow: mockups iterated from the real
frontend code. His conclusion: once you get over the fear of sharing prompts, it takes down knowledge silos across a
company.

Scout's threads are already public, so the same thing is possible here. The rest of this page is what it would take.

## What to ask

### About a person

- **How does Vyctor prototype?** Scout reads their threads and describes the loop: where they start, what they hold on
  to themselves and what they hand over, how they tighten the request as they go, with their own words quoted.
- **Onboarding.** A new teammate asks for the three best threads on debugging the workspace and gets real examples, not
  a wiki page that went stale.
- **Who has solved this before?** Scout points at the person as well as the thread, so you can ask them.

### About a repository

- **Where does the architecture get in the way?** Which modules keep turning up in threads where work was slow or went
  through several rounds of review.
- **What do people keep asking?** Questions that recur point at missing docs or a confusing interface. Scout ranks
  them, so the fixes can be chosen rather than guessed.
- **How did this feature get built?** The history of a feature from the first question to the merged change, in one
  answer.

### About the team

- **Which habits get a pull request that merges first time, and which lead to rework?**
- **Shared mistakes.** The same wrong assumption in five threads is a profile or docs fix, not five lessons.
- **Patterns worth copying**, with the thread as evidence.

## What every answer owes people

Reading someone's threads to learn from them is not the same as judging them. Answers describe patterns and show
examples; they don't rank people or score their productivity. This is all public work, so there is no opt-out;
what an answer owes people is care. Scout says what it read and how much of it, so an answer can be checked.

## What each question needs

| Needs | For | Today |
|---|---|---|
| Whole threads, by person, repository and date | every question above | `read_history`. |
| Which repository a thread worked in | repository questions | Pull requests carry theirs; a thread is a repository's by its channel. |
| What became of the work: merged, closed, reworked, abandoned | "first time" and "where is it slow" | Each pull request is merged, closed or open, with the reviews that asked for changes (`repo_activity`). |
| What happened to the change afterwards | "did the architecture serve us" | Reverts, fixes and follow-ups are found in later pull requests' descriptions and joined to the thread (`outcome`). Which files later changes touched is not. |
| A longer memory | questions over months | `SCOUT_RETENTION_DAYS` removes quiet threads' words from the index; pull requests stay. A long-range question needs a longer window. |

### Outcome signals from the code host

The signals come from the code host Scout already talks to, and its token already reads them (`repo`, and
`notifications` on GitHub), so none of this needs more access:

- the pull request through to its end: reviews, review comments, merge, or closing without a merge;
- the issues it mentions or closes (`Fixes #12`);
- later pull requests that say they fix or revert it: the sign that the first change didn't hold;
- later pull requests that build on it, which is the sign that it did.

Rework and reverts are a better measure of whether a change served the code than merge rate, which only says whether
people accepted it. Still to come: later pull requests that touch the same files soon after a merge without saying so, and
what commit messages say.

Scout sees what people say in Slack and what it replies, and, once crawled, a short line for each command it ran (kept out
of ordinary searches). It doesn't keep the agent's reasoning where a tool can read it, so an answer about how someone
drives their agent is an answer about their conversation, not about every step the agent took.

## What exists today

- Every thread's text, and the code host's pull requests, issues and reviews, are searchable (`search_history`),
  redacted for secrets, with the speaker and channel kept.
- Whole threads and pull requests are readable (`read_history`), and a repository's recent work is countable
  (`repo_activity`). [Operations](operations.md#asking-about-earlier-work-people-and-repositories) says who may ask.
- Scout records its pull requests and what became of them, and reads reviews, review comments and CI.
- Channel notes, thread recaps and the weekly summary.

## Suggested order

How it is built, stage by stage: [session-index.md](session-index.md).

1. A tool that reads whole threads by person, repository and date, capped and redacted. *(done)*
2. An outcome kept per thread, from the pull request and what followed it. *(done)*
3. Profile guidance for "how does X work" questions: quote, describe, don't judge. *(done)*
4. A repository summary from what Scout already has: threads, pull requests merged, rounds of review. *(done; time to a
   first answer is not)*
5. Search by meaning, only if it beats words on real questions (the embeddings gate in session-index.md).
