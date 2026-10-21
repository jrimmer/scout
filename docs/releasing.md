# Releasing Scout

**Version numbers:**
- Versions follow [semantic versioning](https://semver.org), and `CHANGELOG.md` says what the public interface is.
- The version lives in `package.json`, and a release is a tag `v<version>` on `main`.

## Each release

1. **CI is green on `main`.** CI covers type checks, the test suite, and the Docker sandbox tests.
2. **Evals pass against the model in production** (`npm run eval`, see [evals.md](evals.md)), compared with the last release's.
3. **A request in Slack has ended in a pull request**, on a build of the release, against the production model and sandboxes. Use a throwaway repository, and close the pull request after. `npm run doctor` is clean.
4. **The changelog:** move `CHANGELOG.md`'s Unreleased section under the new version and date.
   - Say what anyone running Scout has to do: new settings, new Slack scopes (paste the manifest again), and profile changes.
   - Put those first.
5. **Bump `package.json`'s version** in the same commit, titled `Release <version>`.
6. **Tag and push:** `git tag -a v<version> -m "Scout <version>"`, then `git push origin main v<version>`.
7. **Make a release** on the code host from the tag, with the changelog's section as its notes.
8. **Deploy it** by following [operations.md](operations.md): only when Scout is idle, then `npm run doctor`.

## Before 1.0

1.0 says Scout can be installed and run by people who didn't build it. These have to hold first:

- [x] **Every part tested at its edges:**
  - the Slack adapter against recorded Slack payloads;
  - an end-to-end test from a Slack event to a pull request;
  - the Docker sandbox driver's tests run in CI.
- [x] **CI on every push to `main` and every pull request.** It gates nothing: a pull request is tested merged with the
  latest `main`, and `main` is tested again after every push, so a red `main` is seen before a deploy.
- [x] **No silent hangs:** a sandbox that dies under a command is noticed, and spoond 3.12.1's lost-command report is handled.
- [ ] **An install from scratch** has followed [setup.md](setup.md) exactly, with nothing missing or wrong. Two ways to do it:
  - Someone who hasn't set Scout up before.
  - The CI job that installs from a clean checkout with `npm ci`, plus `npm run doctor` against a test configuration.
- [ ] **The issue tracker:** `now` and `next` issues are closed, or moved to `later` with a reason.
