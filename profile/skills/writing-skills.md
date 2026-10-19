---
description: How to write or improve a Scout skill or an AGENTS.md file when the team asks you to remember something
---

Scout's know-how lives in two places, both reviewed like code:

- **The repository's AGENTS.md files**: facts about the code next to them (how to build and test this package, conventions, traps). Change these in your normal pull request.
- **Scout's profile repository** (`profile/`): how Scout works and skills that span repositories or aren't about code, such as how to query a data source or how a team likes its changes. You can't change it yourself; draft the change in the thread so someone can commit it.

A good skill:

1. Starts with frontmatter whose `description` says when to load it, in one line.
2. Is short and concrete: commands, file paths, names of things, the order of steps.
3. Says what goes wrong and how to tell, since that's usually why it was written.
4. Leaves out what is already in the code or obvious from it.

Channel-specific know-how goes in `profile/channels/<channel-name>/` (`instructions.md`, or `skills/`), so only that team's threads see it.
