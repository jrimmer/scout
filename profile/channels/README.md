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
model: anthropic/claude-sonnet-5-5    # optional: this team's model, if not the default
alerts: Checkout, payments-api        # optional: alerts this team owns (a Gatus group or name, a Grafana label value)
oncall: "@ann"                        # optional: whom to mention when one of them fires
---
We ship on Tuesdays. Ask in #payments before changing anything under libs/payments.
When you've looked into an alert, mention @ann with your verdict.
```

A team that works in several repositories lists them, `repo: gatus, grafana`: the first is the default, and a thread
starts in the one its first message names ("the grafana alert rule for disk space…"). An alert's thread names its
source, so `#alerts` with `repo: gatus, grafana` puts a Gatus alert in `gatus` and a Grafana one in `grafana`.

Edits apply to the next request in every thread; no restart needed.
