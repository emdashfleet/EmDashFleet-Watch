// Tests of the two workflow files, parsed as text without a YAML package
// (tracker APC-030, APC-032): permissions, schedule, secrets wiring, pinned
// actions, expressions in run: blocks, the GitHub environment each job references
// (HR-221) and the separation of the production and the staging secrets. Run with
// `npm test`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ROOT, TOKEN, runCheck, stubCurl } from "./helpers.mjs";

/** The run: block of the first step, which fetches the scripts folder with the runner's own git (security audit of 2026-11-21, Watch S12). */
const FETCH_SCRIPTS = [
  "      - run: |",
  "          git init -q .",
  '          git remote add origin "https://github.com/$GITHUB_REPOSITORY.git"',
  '          git -c protocol.version=2 fetch -q --no-tags --depth 1 origin "$GITHUB_SHA"',
  "          git checkout -q FETCH_HEAD -- scripts",
].join("\n");

/**
 * What each workflow must hold; the staging file differs in these values only. `environment` is
 * both the GitHub environment the job references (the home of its two secrets, HR-221) and the
 * WATCH_ENVIRONMENT value the check script names in its alert.
 */
const WORKFLOWS = {
  "watch.yml": {
    name: "watch",
    group: "watch",
    cron: "7,22,37,52 * * * *",
    healthzUrl: "https://app.emdashfleet.com/healthz",
    landingUrl: "https://emdashfleet.com/",
    tokenSecret: "WATCH_CHECKIN_TOKEN",
    hookSecret: "SLACK_WATCH_WEBHOOK_URL",
    environment: "production",
  },
  "watch-staging.yml": {
    name: "watch-staging",
    group: "watch-staging",
    cron: "12,27,42,57 * * * *",
    healthzUrl: "https://staging.emdashfleet.com/healthz",
    landingUrl: "${{ vars.STAGING_SITE_URL }}",
    tokenSecret: "WATCH_CHECKIN_TOKEN_STAGING",
    hookSecret: "SLACK_WATCH_WEBHOOK_URL_STAGING",
    environment: "staging",
  },
};

const read = (file) => readFileSync(join(ROOT, ".github", "workflows", file), "utf8");
/** The file without comment lines, which may name things the file must not use. */
const code = (file) => read(file).split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");

/** The steps of the one job: { name, if, uses, env, run, lines }. */
function steps(file) {
  const lines = code(file).split("\n");
  const starts = lines.flatMap((line, index) => (/^      - /.test(line) ? [index] : []));
  return starts.map((start, i) => {
    const block = lines.slice(start, starts[i + 1] ?? lines.length);
    const text = block.join("\n");
    const field = (key) => new RegExp(`^(?:      - |        )${key}: (.*)$`, "m").exec(text)?.[1] ?? null;
    const env = {};
    const at = block.findIndex((line) => line === "        env:");
    if (at >= 0) {
      for (const line of block.slice(at + 1)) {
        const entry = /^          ([A-Z_]+): (.*)$/.exec(line);
        if (entry === null) break;
        env[entry[1]] = entry[2];
      }
    }
    return { name: field("name"), if: field("if"), uses: field("uses"), run: field("run"), env, text };
  });
}

for (const [file, want] of Object.entries(WORKFLOWS)) {
  describe(file, () => {
    test("is named, and triggers on a 15 minute schedule and by hand only", () => {
      const text = code(file);
      assert.match(text, new RegExp(`^name: ${want.name}$`, "m"));
      assert.ok(text.includes(`on:\n  schedule:\n    - cron: "${want.cron}"\n  workflow_dispatch:\n\npermissions:`), `cron is ${want.cron}`);
      assert.equal(text.match(/cron:/g).length, 1);
      // Every 15 minutes, none of them minute 0: the start of every hour is a documented
      // high-load time at which a scheduled run can be delayed or dropped (security audit of
      // 2026-11-21, Watch S13). The two workflows never share a minute.
      const minutes = want.cron.split(" ")[0].split(",").map(Number);
      assert.deepEqual(minutes.map((minute, i) => (minutes[(i + 1) % minutes.length] - minute + 60) % 60), [15, 15, 15, 15]);
      assert.ok(!minutes.includes(0), "no run at the start of the hour");
      assert.match(want.cron, /^\d{1,2}(,\d{1,2}){3} \* \* \* \*$/);
      for (const trigger of ["push", "pull_request", "pull_request_target", "workflow_run", "issue_comment", "repository_dispatch"]) {
        assert.doesNotMatch(text, new RegExp(`^  ${trigger}:`, "m"));
      }
    });

    test("declares permissions contents: read and no other permission", () => {
      const text = code(file);
      assert.match(text, /^permissions:\n  contents: read\n\nconcurrency:/m);
      assert.equal(text.match(/permissions:/g).length, 1);
    });

    // A run in progress is never cancelled and only one run of the workflow is in progress at a
    // time, so a dispatch inside the window of a run, or two delayed scheduled runs, cannot post
    // <!channel> or write a check-in twice (security audit of 2026-11-21, Watch S3). The groups
    // of the two files differ, so a staging run never waits for a production run.
    test("runs one run of the workflow at a time and never cancels the one in progress", () => {
      const text = code(file);
      assert.match(
        text,
        new RegExp(`^permissions:\\n  contents: read\\n\\nconcurrency:\\n  group: ${want.group}\\n  cancel-in-progress: false\\n\\njobs:`, "m"),
      );
      assert.equal(text.match(/^concurrency:/gm).length, 1);
      assert.doesNotMatch(text, /cancel-in-progress: true/);
    });

    // No third-party code runs in the job that holds the secrets: a poisoned action bump could
    // write GITHUB_ENV or GITHUB_PATH before the healthz step (security audit of 2026-11-21,
    // Watch S12).
    test("runs no action: the scripts folder comes from the runner's own git, without a token", () => {
      const text = code(file);
      assert.doesNotMatch(text, /uses:/);
      assert.ok(text.includes(`steps:\n${FETCH_SCRIPTS}\n\n      - name: healthz`), "the fetch step is the first step, exactly");
      assert.doesNotMatch(text, /GITHUB_TOKEN|github\.token|secrets\.GITHUB/);
    });

    test("runs one job with a timeout that holds both steps and their retry", () => {
      const text = code(file);
      assert.equal(text.match(/^  [a-z-]+:$/gm).filter((key) => key !== "  schedule:").length, 1);
      const minutes = Number(/timeout-minutes: (\d+)/.exec(text)?.[1]);
      assert.ok(minutes >= 12 && minutes <= 30, `timeout-minutes is ${minutes}`);
      // The worst case of one step is 10 s for the first request, 300 s of waiting, 10 s for the
      // second request and 10 s for the alert post: 330 s. Two steps and a 120 s margin for the
      // fetch of the scripts and the start of the job must fit (security audit of 2026-11-21, Watch S4).
      assert.ok(minutes * 60 >= 2 * 330 + 120, `timeout-minutes ${minutes} leaves less than 120 s beyond two worst-case steps`);
      assert.match(text, /^ {4}runs-on: ubuntu-latest$/m);
      // The fetch writes the scripts folder only (security audit of 2026-11-21).
      assert.match(text, /^ {10}git checkout -q FETCH_HEAD -- scripts$/m);
      assert.doesNotMatch(text, /continue-on-error/);
    });

    // The one place a curl variable, a PATH entry or a different shell could reach both steps
    // without any step changing is a workflow-level or job-level env:, a defaults: block or a
    // shell: key, so none exists; each step's own env: is the only one (security audit of
    // 2026-11-21, Watch S4).
    test("has no workflow-level or job-level env:, no defaults: and no shell:", () => {
      const text = code(file);
      assert.doesNotMatch(text, /^env:/m, "a workflow-level env:");
      assert.doesNotMatch(text, /^ {4}env:/m, "a job-level env:");
      assert.doesNotMatch(text, /^defaults:/m, "a workflow-level defaults:");
      assert.doesNotMatch(text, /^ {4}defaults:/m, "a job-level defaults:");
      assert.doesNotMatch(text, /^\s*(?:- )?shell:/m, "a shell: key");
      assert.doesNotMatch(text, /\$GITHUB_(?:ENV|PATH)\b/, "a write to GITHUB_ENV or GITHUB_PATH");
      const envs = text.match(/^\s*env:/gm) ?? [];
      assert.equal(envs.length, 2, "one step env: for each of the two steps");
      for (const step of steps(file)) if (step.name !== null) assert.match(step.text, /^ {8}env:$/m, step.name);
    });

    test("has the two separate steps, healthz first, the landing page after a failed one", () => {
      const [fetchScripts, healthz, landing, ...rest] = steps(file);
      assert.equal(rest.length, 0);
      assert.equal(fetchScripts.run, "|");
      assert.equal(fetchScripts.name, null);
      assert.equal(healthz.name, "healthz");
      assert.equal(healthz.run, "bash scripts/watch-check.sh healthz");
      assert.equal(healthz.if, null);
      assert.equal(landing.name, "landing page");
      assert.equal(landing.run, "bash scripts/watch-check.sh landing");
      assert.equal(landing.if, "${{ !cancelled() }}");
      assert.ok(existsSync(join(ROOT, "scripts", "watch-check.sh")));
    });

    // The two secrets of the workflow are secrets of the GitHub environment named here, not
    // repository secrets, so only a job that references the environment, from a branch the
    // environment allows, receives them (HR-221). The name is the plain string form, written once,
    // and equals the WATCH_ENVIRONMENT of both steps.
    test("references the GitHub environment of its own, once, as a plain name", () => {
      const text = code(file);
      assert.match(text, new RegExp(`^jobs:\\n  watch:\\n    runs-on: ubuntu-latest\\n    environment: ${want.environment}\\n    timeout-minutes: \\d+\\n    steps:\\n`, "m"));
      assert.equal((text.match(/^\s*environment:/gm) ?? []).length, 1, "one environment: key");
      assert.doesNotMatch(text, /^\s*deployment:/m, "no deployment: key");
      for (const step of steps(file).filter((step) => step.name !== null)) {
        assert.equal(step.env.WATCH_ENVIRONMENT, want.environment, `${step.name} names another environment than the job references`);
      }
    });

    test("wires the secrets of its own environment into the step env and nowhere else", () => {
      const [, healthz, landing] = steps(file);
      assert.deepEqual(healthz.env, {
        WATCH_URL: want.healthzUrl,
        WATCH_TOKEN: `\${{ secrets.${want.tokenSecret} }}`,
        WATCH_WEBHOOK: `\${{ secrets.${want.hookSecret} }}`,
        WATCH_ENVIRONMENT: want.environment,
      });
      assert.deepEqual(landing.env, {
        WATCH_URL: want.landingUrl,
        WATCH_WEBHOOK: `\${{ secrets.${want.hookSecret} }}`,
        WATCH_ENVIRONMENT: want.environment,
      });
      const secretLines = code(file).split("\n").filter((line) => line.includes("secrets."));
      assert.equal(secretLines.length, 3);
      for (const line of secretLines) assert.match(line, /^          WATCH_(TOKEN|WEBHOOK): \$\{\{ secrets\.[A-Z_]+ \}\}$/);
      assert.doesNotMatch(code(file), /secrets: inherit|secrets\[|toJSON|GITHUB_TOKEN/);
    });

    test("holds no expression in a run: block and no expression but the allowed ones", () => {
      const text = code(file);
      for (const step of steps(file)) {
        if (step.run !== null) assert.ok(!step.run.includes("${{"), `${step.name} run: holds an expression`);
      }
      assert.doesNotMatch(text, /^\s+run: [|>]/m, "a multi-line run: block would need a review of its expressions");
      const expressions = [...text.matchAll(/\$\{\{ (.*?) \}\}/g)].map((match) => match[1]);
      for (const expression of expressions) {
        assert.match(expression, /^(secrets\.[A-Z_]+|!cancelled\(\)|vars\.STAGING_SITE_URL)$/);
        assert.ok(!expression.startsWith("github."), "a github context value reaches the file");
      }
    });

    // The check script binds the bearer token to the healthz address of the environment (security
    // audit of 2026-11-21, Watch S5); the literals of this workflow must be the ones it accepts,
    // or the watch would stop with exit 2. A stub curl keeps every request off the network.
    test("the healthz address and the environment of the step are the ones the check script accepts", async () => {
      const healthz = steps(file).find((step) => step.name === "healthz");
      const stub = stubCurl();
      try {
        const { code, output } = await runCheck("healthz", {
          PATH: stub.path,
          WATCH_URL: healthz.env.WATCH_URL,
          WATCH_ENVIRONMENT: healthz.env.WATCH_ENVIRONMENT,
          WATCH_TOKEN: TOKEN,
          WATCH_WEBHOOK: "https://hooks.slack.com/services/T000/B000/HOOKSECRET9d41c7e2",
        });
        assert.equal(output.trim(), "healthz attempt 1: HTTP 200");
        assert.equal(code, 0);
        assert.ok(existsSync(stub.log), "the stub curl was called");
      } finally {
        rmSync(stub.dir, { recursive: true, force: true });
      }
    });

    test("does not use the test mode of the check script and does not trace", () => {
      const text = code(file);
      assert.doesNotMatch(text, /WATCH_TEST_|set -x|ACTIONS_STEP_DEBUG|xtrace/);
    });
  });
}

describe("production and staging", () => {
  const production = code("watch.yml").split("\n");
  const staging = code("watch-staging.yml").split("\n");

  test("the two workflows run at different minutes", () => {
    const minutes = (file) => /cron: "([\d,]+) /.exec(code(file))[1].split(",");
    const shared = minutes("watch.yml").filter((minute) => minutes("watch-staging.yml").includes(minute));
    assert.deepEqual(shared, []);
  });

  test("watch-staging.yml is watch.yml with only the staging values changed", () => {
    assert.equal(staging.length, production.length);
    const differing = production.flatMap((line, index) => (line === staging[index] ? [] : [[line.trim(), staging[index].trim()]]));
    assert.deepEqual(differing, [
      ["name: watch", "name: watch-staging"],
      ['- cron: "7,22,37,52 * * * *"', '- cron: "12,27,42,57 * * * *"'],
      ["group: watch", "group: watch-staging"],
      ["environment: production", "environment: staging"],
      ["WATCH_URL: https://app.emdashfleet.com/healthz", "WATCH_URL: https://staging.emdashfleet.com/healthz"],
      ["WATCH_TOKEN: ${{ secrets.WATCH_CHECKIN_TOKEN }}", "WATCH_TOKEN: ${{ secrets.WATCH_CHECKIN_TOKEN_STAGING }}"],
      ["WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL }}", "WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL_STAGING }}"],
      ["WATCH_ENVIRONMENT: production", "WATCH_ENVIRONMENT: staging"],
      ["WATCH_URL: https://emdashfleet.com/", "WATCH_URL: ${{ vars.STAGING_SITE_URL }}"],
      ["WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL }}", "WATCH_WEBHOOK: ${{ secrets.SLACK_WATCH_WEBHOOK_URL_STAGING }}"],
      ["WATCH_ENVIRONMENT: production", "WATCH_ENVIRONMENT: staging"],
    ]);
  });

  test("watch-staging.yml never names a production secret, even in a comment", () => {
    const text = read("watch-staging.yml");
    assert.doesNotMatch(text, /SLACK_WATCH_WEBHOOK_URL(?!_STAGING)/);
    assert.doesNotMatch(text, /WATCH_CHECKIN_TOKEN(?!_STAGING)/);
    assert.doesNotMatch(text, /NIGHTLY_CHECKIN|SLACK_CI_WEBHOOK|SLACK_MAIL_WEBHOOK|app\.emdashfleet\.com|https:\/\/emdashfleet\.com/);
    assert.match(text, /SLACK_WATCH_WEBHOOK_URL_STAGING/);
    assert.doesNotMatch(code("watch-staging.yml"), /^\s*environment: production$/m, "the staging job references the production environment");
  });

  test("watch.yml never names a staging secret, address or environment, even in a comment", () => {
    const text = read("watch.yml");
    assert.doesNotMatch(text, /_STAGING|staging|STAGING_SITE_URL/);
    assert.doesNotMatch(code("watch.yml"), /^\s*environment: staging$/m, "the production job references the staging environment");
  });

  // The environment is the second lock on the secrets (HR-221): production is the only
  // environment whose job runs from main alone, and the two names are never shared.
  test("the two workflows reference two different GitHub environments", () => {
    const environment = (file) => /^ {4}environment: (\S+)$/m.exec(code(file))?.[1];
    assert.equal(environment("watch.yml"), "production");
    assert.equal(environment("watch-staging.yml"), "staging");
  });

  test("every script and workflow other than the check scripts uses the same check script", () => {
    for (const file of Object.keys(WORKFLOWS)) {
      const runs = steps(file).flatMap((step) => (step.run === null ? [] : [step.run]));
      // The first run: block is the fetch of the scripts folder (FETCH_SCRIPTS, pinned above).
      assert.deepEqual(runs, ["|", "bash scripts/watch-check.sh healthz", "bash scripts/watch-check.sh landing"]);
    }
  });
});
