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

Edits apply to the next request in every thread; no restart needed.
