# Scout

A coding teammate that lives in Slack and works only in public. Mention `@Scout` in a public channel and it reads
the code, runs tests, makes the change, and opens a pull request, in a thread anyone can follow, join, and learn
from. Modelled on Shopify's River; see [docs/design.md](docs/design.md).

- One Slack thread is one durable conversation ([Pi Durable](https://earendil.com/posts/pi-durable/)): it survives
  restarts, and anyone in the thread can redirect the work.
- Each thread gets its own clone and Docker container. Credentials never enter it.
- What Scout knows lives in `profile/` as files: a system prompt, skills, and per-channel instructions.

## Run it

Needs Node 24+, Docker, and git with access to your repository.

```bash
npm install
docker build -t scout-sandbox:latest sandbox    # add your repo's toolchains to sandbox/Dockerfile first
cp .env.example .env                             # fill it in; create the Slack app from slack-manifest.yaml
npm start
```

Invite Scout to a public channel and mention it. Data (transcripts, clones, the thread map) lives in `data/`.

## Develop

```bash
npm test                                   # unit and end-to-end tests with a scripted model
SCOUT_DOCKER_TESTS=1 npm test              # also the real container, clone, and push
npm run check                              # type-check
```
