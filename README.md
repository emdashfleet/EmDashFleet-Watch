# EmDashFleet-Watch

Checks EmDash Fleet from outside Cloudflare. The scheduled workflows `watch.yml` (production) and `watch-staging.yml` (staging) request Fleet's public URLs, post to Slack when a check fails and check in with Fleet, so Fleet notices when the watch itself stops. Their run logs are public and hold nothing but the HTTP status of each URL checked.

## Branches

- A co-founder pushes alone (emdashfleet_app_plan.md D31, HR-162): there is no pull request, review, approver, signed commit or local hook.
- `dev` is the integration branch: push to it while working.
- `main` runs the scheduled workflows, because GitHub runs scheduled workflows from the default branch only: push to it when a change is ready. `scripts/keepalive.sh` adds an empty commit to `main` (its default branch; it refuses a tag), so merge `main` into `dev` before the next push of `dev` to `main`.

## Files

- `.github/workflows/watch.yml` checks production: `https://app.emdashfleet.com/healthz` with the Bearer token `WATCH_CHECKIN_TOKEN` (which is also the check-in Fleet reads) and `https://emdashfleet.com/`, as two steps. A check fails on a status other than 200 or on no answer within 10 seconds and is repeated once 5 minutes later; when both attempts fail the step posts to Slack through `SLACK_WATCH_WEBHOOK_URL` and the run fails. Secrets of the `production` environment (see Secrets and environments): `WATCH_CHECKIN_TOKEN` and `SLACK_WATCH_WEBHOOK_URL`.
- `.github/workflows/watch-staging.yml` is the same watch for staging: `https://staging.emdashfleet.com/healthz` with `WATCH_CHECKIN_TOKEN_STAGING` (which writes the staging `cron_checkin` row `watch.yml`) and the address in the repository variable `STAGING_SITE_URL`, alerts through `SLACK_WATCH_WEBHOOK_URL_STAGING` to `#fleet-alerts-staging` only. Secrets of the `staging` environment: `WATCH_CHECKIN_TOKEN_STAGING` and `SLACK_WATCH_WEBHOOK_URL_STAGING`; repository variable (not secret): `STAGING_SITE_URL`.
- `.github/workflows/ci.yml` checks every push to `dev` and `main` and every pull request into them (Dependabot's) with a read-only token and no secret: gitleaks 8.30.1 (the archive is checked against its SHA-256) and `npm test`: every push scans the whole history of every ref and a pull request scans its own commits, so no push depends on the run of an earlier one. `.github/dependabot.yml` opens the weekly pull requests into `dev` for the GitHub Actions, the only ecosystem in use (`package.json` holds no dependency), and a co-founder merges them. `.nvmrc` holds the exact Node.js version and `.gitleaks.toml` configures gitleaks, which runs in `ci.yml` only: nothing is installed or configured in a clone.
- `scripts/watch-check.sh` is the one check script of the workflows. It needs `bash` and `curl` only and prints nothing but each URL's HTTP status.
- `scripts/keepalive.sh` is run by the monthly privileged-access review. GitHub disables scheduled workflows in a public repository after 60 days without activity, so the script pushes one empty commit, made with the operator's own configured git identity (it refuses to run when `user.name` and `user.email` are not set, instead of letting git guess them), to `main` as a fast-forward, from a temporary clone. Run it as `bash scripts/keepalive.sh` (add `--dry-run` to push nothing and `--check-state` to read the state of `watch.yml` and `watch-staging.yml` with `gh` afterwards, also in a dry run). It is a push to `main` like any other.

## Secrets and environments

The four secrets of the two watch workflows are secrets of GitHub environments, not repository secrets (HR-221). Secrets stored in an environment are only available to workflow jobs that reference the environment, and the environment's deployment branch rule is matched against the `GITHUB_REF` of the workflow run, so a run from a branch the rule does not allow cannot deploy to the environment. Environments are available for a public repository on GitHub Free, as this one is (https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments, Environment secrets and Deployment branches and tags; https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

| Environment | Deployment branches (Selected branches and tags, ref type Branch) | Secrets | Referenced by |
| --- | --- | --- | --- |
| `production` | `main` only | `WATCH_CHECKIN_TOKEN`, `SLACK_WATCH_WEBHOOK_URL` | `watch.yml` |
| `staging` | `main` and `dev` | `WATCH_CHECKIN_TOKEN_STAGING`, `SLACK_WATCH_WEBHOOK_URL_STAGING` | `watch-staging.yml` |

- The secret names are the same as before, so the `secrets.*` expressions of the workflows and everything else that names a secret stay as they are. Only the place that holds the secrets moves.
- `staging` also allows `main` because GitHub runs a scheduled workflow from the default branch only (`GITHUB_REF` of a `schedule` event is the default branch: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); a rule limited to `dev` would refuse every scheduled staging run. It also allows `dev` so that `watch-staging.yml` can be dispatched by hand from `dev` to test a change. `watch.yml` dispatched from `dev` is not allowed to use `production`, on purpose.
- Neither environment has required reviewers or a wait timer: a run that waits for an approval never completes unattended. Both create a deployment record for each run, because a job that references an environment creates a deployment object by default (https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments); the environment is displayed on the main page of the repository.
- `STAGING_SITE_URL` stays a repository variable: it is public and the repository variables are not part of this change.

The owner moves the secrets once, in this order (nothing here is done by a script or by Claude):

1. Settings, Environments, New environment: create `production`. Under Deployment branches and tags choose Selected branches and tags, Add deployment branch or tag rule, Ref type Branch, name pattern `main`, Add rule. Add no reviewer and no wait timer.
2. Create `staging` the same way with two rules, `main` and `dev`.
3. In each environment, under Environment secrets, Add secret: `production` gets `WATCH_CHECKIN_TOKEN` and `SLACK_WATCH_WEBHOOK_URL`, `staging` gets `WATCH_CHECKIN_TOKEN_STAGING` and `SLACK_WATCH_WEBHOOK_URL_STAGING`, each with the value of the repository secret of the same name (GitHub never shows a secret again; take the value from where it is stored). A secret of an environment takes precedence over a repository secret of the same name (https://docs.github.com/en/actions/reference/security/secrets), so steps 1 to 3 change nothing for a workflow that does not reference the environment yet.
4. Push this change from `dev` to `main`. From the next scheduled run each job references its environment. Do not read a green run before step 5 as proof of the environment secrets: the repository secrets of the same names still exist until then.
5. Staging first, because its alerts go to `#fleet-alerts-staging`: delete the repository secrets `WATCH_CHECKIN_TOKEN_STAGING` and `SLACK_WATCH_WEBHOOK_URL_STAGING` (Settings, Secrets and variables, Actions, Repository secrets), then at once run Actions, `watch-staging`, Run workflow on branch `main`, and check that the run is green and that the main page of the repository lists a deployment to `staging`. Keep the repository variable `STAGING_SITE_URL`.
6. Production only when step 5 is green, because a failing production run posts to `#fleet-alerts`: delete the repository secrets `WATCH_CHECKIN_TOKEN` and `SLACK_WATCH_WEBHOOK_URL`, then at once run `watch` on branch `main` and check it the same way. A failure in step 5 or 6 means that a value typed in step 3 is wrong: correct the environment secret and run the workflow again.

Why this order: a job that references an environment that does not exist creates it with no protection rule and no secret (https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments), so the environments and their rules exist before the push in step 4; and a repository secret deleted before the push in step 4 would leave the old workflow on `main` with empty secrets and a failing watch.

## What `ci.yml` and Dependabot do and do not cover

- `ci.yml` is a signal after the push, not a gate: `watch.yml` runs from `main` on its schedule with no dependency on the result of `ci.yml`, so a green `npm test` is not an approval of a change.
- The pull requests that Dependabot opens into `dev` are its version updates. A Dependabot security update always uses the default branch (https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), so if security updates are enabled for this repository, the pull request for an advisory on an action opens against `main`, runs `ci.yml` before the merge, needs the `CHECKOUT` constant of `test/workflows.test.mjs` edited in the same change, and `main` must be merged into `dev` before the next push of `dev` to `main`.
- The gitleaks version and its SHA-256 in `ci.yml` and `.nvmrc` are raised by hand: `dependabot.yml` tracks GitHub Actions only, so no updater covers them, and the monthly privileged-access review (above) is where they are compared with the newest stable release.

## Tests

The tests need Node.js 26.13.1 or newer (`.nvmrc`) and no package: `npm test` runs `node --test "test/*.test.mjs"`. They run the check script against a local HTTP server and a stub webhook, parse the workflow files and check the hygiene files (`test/hygiene.test.mjs`). They never reach a real address or a real webhook.
