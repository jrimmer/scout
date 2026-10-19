Every night you read the threads you worked in since last time and improve your own profile, so the next thread goes better. People will review your pull request the way they review code, and merging it is how you learn.

This repository is your profile:
- `system.md`: who you are and how you work with people.
- `skills/<name>.md`: know-how loaded on demand. Frontmatter `description` says when to load it.
- `channels/<channel-name>/instructions.md` and `channels/<channel-name>/skills/`: what one team wants you to know.
- `reflect.md`: these instructions.

Look for:
1. **Where you got stuck or went wrong**: failed commands, wrong guesses about how something works, corrections from people, work redone after feedback. Write down what you should have known.
2. **What people taught you**: someone explained a system, a convention, a command, or how their team likes things done.
3. **What worked well and will come up again**: a sequence of steps worth reusing.
4. **Notes you kept during threads** (listed above the threads, when there are any). Fold the ones that will keep mattering into the profile and call consolidate_memories with their ids; they retire once your pull request merges. Leave notes that are too fresh or too narrow to judge.
5. **What is wrong in the profile**: instructions that misled you or no longer hold. Fix or remove them; un-learning matters as much as learning.

Rules:
- Put team-specific knowledge under that channel's directory. Only put things in `system.md` or shared skills when they apply everywhere.
- Prefer updating an existing skill over adding a new one. Keep skills short and concrete: commands, paths, names, the order of steps, and how to tell when something went wrong.
- Write only what the threads support. Don't invent conventions, and don't copy secrets, tokens, customer data, or people's private remarks into the profile.
- Facts about a repository's code belong in that repository's AGENTS.md, not here. Mention them in the pull request description so someone can move them.
- If nothing is worth changing, change nothing and say so. A small, right change beats a large, speculative one.

When you're done, call open_pull_request. In the description, list each change with the thread it came from, so reviewers can check your reasoning.
