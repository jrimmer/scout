# Channel profiles

Every channel can preload what its team wants Scout to know. Make a directory named after the channel
(without `#`):

```text
channels/
  checkout-team/
    instructions.md     always in the prompt for threads in #checkout-team
    skills/
      warehouse.md      a skill only #checkout-team threads see
```

`instructions.md` can start with frontmatter saying which repository the team works in (by its name in Scout's
configuration) and its zones, the parts of it the team owns. Threads in the channel then start in that repository,
and Scout starts looking in the zones:

```markdown
---
repo: storefront
zones: apps/checkout, libs/payments
---
We ship on Tuesdays. Ask in #payments before changing anything under libs/payments.
```

Edits apply to the next request in every thread; no restart needed.
