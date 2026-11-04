# Session querying: learning from how people work with Scout

Everything said in Scout's threads is public, so everything in them can be read by anyone, and so by Scout on
someone's behalf. That turns the history into something to ask questions of: not only "has this come up before"
(`search_threads` does that today) but "how does this person work" and "how is this repository doing".

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
examples; they don't rank people or score their productivity. People can opt out of being the subject of a question,
and Scout says what it read and how much of it, so an answer can be checked.

## What each question needs

| Needs | For | Today |
|---|---|---|
| Whole threads, by person, repository and date | every question above | Not built. `search_threads` returns five snippets, one per thread, and can't filter by person. |
| Which repository a thread worked in | repository questions | Known (the thread's repository). |
| What became of the work: merged, closed, reworked, abandoned | "first time" and "where is it slow" | Partly. Scout records each pull request it opens as open, merged or closed, with its CI result and the review comments it reads. |
| What happened to the change afterwards | "did the architecture serve us" | Not built. See below. |
| A longer memory | questions over months | `SCOUT_RETENTION_DAYS` removes quiet threads from the search index; a long-range question needs a longer window. |

### Outcome signals from the code host

The signals come from the code host Scout already talks to, and its token already reads them (`repo`, and
`notifications` on GitHub), so none of this needs more access. What's missing is asking:

- the pull request through to its end: reviews, review comments, CI runs, merge, or closing without a merge (partly
  recorded already);
- the issues it mentions or closes (`Fixes #12`), and the comments on them;
- later pull requests that touch the same files soon after a merge, or say they fix or revert it: the sign that the
  first change didn't hold;
- later pull requests that build on it, which is the sign that it did.

Rework and reverts are a better measure of whether a change served the code than merge rate, which only says whether
people accepted it.

Scout sees what people say in Slack and what it replies. It doesn't keep the agent's own tool calls and reasoning where
a tool can read them (they stay in Pi Durable's storage), so an answer about how someone drives their agent is an
answer about their conversation, not about every step the agent took.

## What exists today

- Every thread's text is searchable (`search_threads`), redacted for secrets, with the speaker and channel kept.
- Scout records its pull requests and what became of them, and reads reviews, review comments and CI.
- Channel notes, thread recaps and the weekly summary.

## Suggested order

1. A tool that reads whole threads by person, repository and date, capped and redacted.
2. An outcome kept per thread, from the pull request and what followed it.
3. Profile guidance for "how does X work" questions: quote, describe, don't judge.
4. A repository summary from what Scout already has: threads, pull requests merged, rounds of review, time to a first
   answer.
