// Tests of scripts/keepalive.sh against a local bare repository (tracker
// APC-031). Nothing is pushed anywhere else: every run passes --remote with a
// temporary path, and the git configuration is a temporary file, so neither the
// operator's configuration nor GitHub is touched. Run with `npm test`.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { ROOT } from "./helpers.mjs";

const SCRIPT = join(ROOT, "scripts", "keepalive.sh");
const DEFAULT_REMOTE = "https://github.com/Zeyadigital/EmDashFleet-Watch.git";
let dir;
let bare;
let config;
let noIdentityConfig;
let redirectConfig;

const git = (args, cwd, env = {}) => execFileSync("git", args, { cwd, env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1", ...env }, encoding: "utf8" }).trim();
const bareGit = (...args) => git(["--git-dir", bare, ...args], dir);

/** Runs the script with a given global git configuration and extra PATH directories. */
function keepalive(args, { gitConfig = config, path = process.env.PATH, remote = bare, env = {} } = {}) {
  const result = spawnSync("bash", [SCRIPT, ...(remote === null ? [] : ["--remote", remote]), ...args], {
    env: { PATH: path, HOME: dir, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1", ...env },
    encoding: "utf8",
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "keepalive-test-"));
  config = join(dir, "operator.gitconfig");
  writeFileSync(config, "[user]\n\tname = Test Operator\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n");
  noIdentityConfig = join(dir, "no-identity.gitconfig");
  // No [user] section and no useConfigOnly: git would guess a name and address from the computer, which the script must refuse.
  writeFileSync(noIdentityConfig, "[init]\n\tdefaultBranch = main\n");

  bare = join(dir, "remote.git");
  git(["init", "--bare", "--quiet", "--initial-branch=main", bare], dir);
  // The default remote (the public repository) is rewritten to the local bare repository, so a run
  // without --remote, which --check-state needs, never reaches GitHub.
  redirectConfig = join(dir, "redirect.gitconfig");
  writeFileSync(redirectConfig, `${readFileSync(config, "utf8")}[url "${bare}"]\n\tinsteadOf = ${DEFAULT_REMOTE}\n`);
  const seed = join(dir, "seed");
  git(["init", "--quiet", seed], dir);
  writeFileSync(join(seed, "README.md"), "seed\n");
  git(["add", "README.md"], seed);
  git(["commit", "--quiet", "-m", "seed"], seed);
  git(["push", "--quiet", bare, "HEAD:refs/heads/main", "HEAD:refs/heads/dev"], seed);
  git(["tag", "light1"], seed);
  git(["tag", "-a", "v1", "-m", "v1"], seed);
  git(["push", "--quiet", bare, "light1", "v1"], seed);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("keepalive.sh", () => {
  test("a dry run creates the commit in a temporary clone and pushes nothing", () => {
    const before = bareGit("rev-parse", "main");
    const { code, output } = keepalive(["--dry-run"]);
    assert.equal(code, 0);
    assert.match(output, /^Dry run: created the commit [0-9a-f]{12} on main as Test Operator <test@example\.invalid>; nothing was pushed\.$/);
    assert.equal(bareGit("rev-parse", "main"), before);
  });

  test("pushes one empty commit to main as a fast-forward", () => {
    const parent = bareGit("rev-parse", "main");
    const dev = bareGit("rev-parse", "dev");
    const { code, output } = keepalive([]);
    assert.equal(code, 0);
    assert.match(output, /^Pushed the keepalive commit [0-9a-f]{12} to main as Test Operator <test@example\.invalid>\.$/);
    const head = bareGit("rev-parse", "main");
    assert.notEqual(head, parent);
    assert.equal(bareGit("rev-parse", `${head}^`), parent, "the commit is a fast-forward of the old head");
    assert.equal(bareGit("rev-parse", `${head}^{tree}`), bareGit("rev-parse", `${parent}^{tree}`), "the commit changes no file");
    assert.match(bareGit("log", "-1", "--format=%s", head), /^Keepalive \d{4}-\d{2}-\d{2}$/);
    assert.equal(bareGit("rev-parse", "dev"), dev, "dev is left alone");
  });

  test("refuses to push when no git identity is configured, instead of letting git guess one", () => {
    const before = bareGit("rev-parse", "main");
    const { code, output } = keepalive([], { gitConfig: noIdentityConfig });
    assert.equal(code, 1);
    assert.match(output, /The commit could not be created\. Set user\.name and user\.email/);
    assert.equal(bareGit("rev-parse", "main"), before);
  });

  // The operator's shell may export GIT_DIR, GIT_INDEX_FILE or GIT_WORK_TREE of another checkout;
  // the script ignores them (security audit of 2026-11-21, Watch S7).
  test("git variables inherited from the operator's shell leave that checkout alone and the push still happens", () => {
    const other = join(dir, "other-checkout");
    git(["init", "--quiet", other], dir);
    writeFileSync(join(other, "mine.txt"), "mine\n");
    git(["add", "mine.txt"], other);
    git(["commit", "--quiet", "-m", "mine"], other);
    const head = git(["rev-parse", "HEAD"], other);
    const index = readFileSync(join(other, ".git", "index"));
    const inherited = {
      GIT_DIR: join(other, ".git"),
      GIT_WORK_TREE: other,
      GIT_INDEX_FILE: join(other, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(other, ".git", "objects"),
      GIT_COMMON_DIR: join(other, ".git"),
      GIT_NAMESPACE: "ns",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "Inherited Name",
    };
    const parent = bareGit("rev-parse", "main");
    const { code, output } = keepalive([], { env: inherited });
    assert.equal(code, 0, output);
    assert.match(output, /^Pushed the keepalive commit [0-9a-f]{12} to main as Test Operator <test@example\.invalid>\.$/);
    assert.notEqual(bareGit("rev-parse", "main"), parent, "the remote received the commit");
    assert.equal(bareGit("rev-parse", "main^"), parent);
    assert.equal(git(["rev-parse", "HEAD"], other), head, "the other checkout has no new commit");
    assert.deepEqual(readFileSync(join(other, ".git", "index")), index, "the other checkout's index is unchanged");
    assert.equal(git(["status", "--porcelain"], other), "");
  });

  // A failing hook, a signing error or a refused clone was reported as a missing identity or a
  // missing branch; the last line git wrote now comes first (security audit of 2026-11-21, Watch S6).
  test("a failing pre-commit hook is shown as the cause of a failed commit, not as a missing identity", () => {
    const hooks = join(dir, "hooks-fail");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\necho 'hook says no: policy check failed' >&2\nexit 1\n");
    chmodSync(join(hooks, "pre-commit"), 0o755);
    const hookConfig = join(dir, "hook.gitconfig");
    writeFileSync(hookConfig, `${readFileSync(config, "utf8")}[core]\n\thooksPath = ${hooks}\n`);
    const before = bareGit("rev-parse", "main");
    const { code, output } = keepalive([], { gitConfig: hookConfig });
    assert.equal(code, 1);
    assert.match(output, /^git: hook says no: policy check failed\nThe commit could not be created\./);
    assert.equal(bareGit("rev-parse", "main"), before);
  });

  test("a clone that git refuses shows git's last line before the message", () => {
    const { code, output } = keepalive(["--branch", "nope"]);
    assert.equal(code, 1);
    assert.match(output, /^git: .+\nThe branch nope could not be cloned from the remote\.$/);
  });

  test("a tag given as --branch is refused, and no branch named after it is created", () => {
    for (const tag of ["v1", "light1"]) {
      const { code, output } = keepalive(["--branch", tag]);
      assert.equal(code, 1, tag);
      assert.match(output, new RegExp(`^${tag} is not a branch of the remote\\.$`));
      assert.throws(() => bareGit("rev-parse", "--verify", "--quiet", `refs/heads/${tag}`), undefined, tag);
    }
  });

  test("a refused push (a protected branch) changes nothing and says so", () => {
    const hooks = join(bare, "hooks");
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, "pre-receive"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(hooks, "pre-receive"), 0o755);
    const before = bareGit("rev-parse", "main");
    try {
      const { code, output } = keepalive([]);
      assert.equal(code, 1);
      assert.match(output, /^git: .*\n.*The push to main was refused/);
      assert.equal(bareGit("rev-parse", "main"), before);
    } finally {
      rmSync(join(hooks, "pre-receive"));
    }
  });

  test("--branch commits to that branch only", () => {
    const main = bareGit("rev-parse", "main");
    const dev = bareGit("rev-parse", "dev");
    const { code } = keepalive(["--branch", "dev"]);
    assert.equal(code, 0);
    assert.equal(bareGit("rev-parse", "main"), main);
    assert.notEqual(bareGit("rev-parse", "dev"), dev);
  });

  test("a branch that does not exist is an error", () => {
    const { code, output } = keepalive(["--branch", "nope"]);
    assert.equal(code, 1);
    assert.match(output, /The branch nope could not be cloned from the remote\./);
  });

  test("bad arguments are refused before any clone", () => {
    for (const args of [["--branch", "--force"], ["--branch", "a..b"], ["--branch", "x y"], ["--bogus"], ["--branch"]]) {
      const { code } = keepalive(args);
      assert.equal(code, 2, args.join(" "));
    }
    assert.equal(keepalive([], { remote: "" }).code, 2);
  });

  // Security audit of 2026-11-21, Watch S8: both refusals come before any clone, so the remote is
  // a path that does not exist and a clone would fail with another message and exit 1.
  test("--check-state with another remote and a remote with user information are refused before any clone", () => {
    const missing = join(dir, "no-such-remote.git");
    const state = keepalive(["--check-state"], { remote: missing });
    assert.equal(state.code, 2);
    assert.equal(state.output, "--check-state reads the public repository and needs the default remote; run it without --remote.");
    const dry = keepalive(["--dry-run", "--check-state"], { remote: bare });
    assert.equal(dry.code, 2, "a dry run is refused too");
    for (const remote of ["https://token@github.com/Zeyadigital/EmDashFleet-Watch.git", "https://user:secret@github.com/x/y.git", "ssh://git@github.com/x/y.git", "https://@github.com/x/y.git"]) {
      const { code, output } = keepalive(["--dry-run"], { remote });
      assert.equal(code, 2, remote);
      assert.equal(output, "The remote holds user information. Remove it; the sign-in of gh or the credential helper of git supplies the credential.");
      assert.ok(!output.includes("secret") && !output.includes("token"), "the message does not repeat the credential");
    }
    // An at sign after the authority is a path, not user information.
    for (const remote of [join(dir, "a@b.git"), `file://${join(dir, "a@b.git")}`]) {
      const path = keepalive(["--dry-run"], { remote });
      assert.equal(path.code, 1, `${remote} gets as far as the clone`);
      assert.match(path.output, /The branch main could not be cloned from the remote\./);
    }
  });

  test("a --remote value that looks like an option is a path: the clone fails and nothing is created", () => {
    const { code, output } = keepalive(["--dry-run"], { remote: "-x" });
    assert.equal(code, 1);
    assert.match(output, /The branch main could not be cloned from the remote\./);
  });

  test("--check-state reads both scheduled workflows through gh, after a push or a dry run, and fails unless both are active", () => {
    const stubs = join(dir, "stubs");
    mkdirSync(stubs, { recursive: true });
    const calls = join(dir, "gh-calls");
    // The stub answers GH_STATE for watch.yml and GH_STAGING for watch-staging.yml.
    writeFileSync(join(stubs, "gh"), `#!/bin/sh\necho "$@" >> "${calls}"\ncase "$*" in *watch-staging.yml*) printf '%s\\n' "$GH_STAGING" ;; *) printf '%s\\n' "$GH_STATE" ;; esac\n`);
    chmodSync(join(stubs, "gh"), 0o755);
    // --check-state needs the default remote, which the configuration redirects to the local bare
    // repository. Check the redirection before any run: without it a push would leave the computer.
    const env = { PATH: `${stubs}:${process.env.PATH}`, HOME: dir, GIT_CONFIG_GLOBAL: redirectConfig, GIT_CONFIG_NOSYSTEM: "1" };
    assert.equal(execFileSync("git", ["ls-remote", "--get-url", DEFAULT_REMOTE], { env, encoding: "utf8" }).trim(), bare);
    const run = (state, staging, extra = []) => {
      const result = spawnSync("bash", [SCRIPT, "--check-state", ...extra], {
        env: { ...env, GH_STATE: state, GH_STAGING: staging },
        encoding: "utf8",
      });
      return { code: result.status, output: `${result.stdout}${result.stderr}`.trim() };
    };
    const active = run("active", "active");
    assert.equal(active.code, 0);
    assert.match(active.output, /watch\.yml state: active\nwatch-staging\.yml state: active/);
    const disabled = run("disabled_inactivity", "active");
    assert.equal(disabled.code, 1);
    assert.match(disabled.output, /watch\.yml is not active\. Run the runbook Re-enable the outside watch\./);
    const staging = run("active", "disabled_manually");
    assert.equal(staging.code, 1);
    assert.match(staging.output, /watch-staging\.yml is not active\./);
    const before = bareGit("rev-parse", "main");
    const dry = run("disabled_inactivity", "active", ["--dry-run"]);
    assert.equal(dry.code, 1, "a dry run still performs the requested check");
    assert.match(dry.output, /nothing was pushed\.\nwatch\.yml state: disabled_inactivity/);
    assert.equal(bareGit("rev-parse", "main"), before);
    const lines = readFileSync(calls, "utf8");
    assert.match(lines, /^api --hostname github\.com repos\/Zeyadigital\/EmDashFleet-Watch\/actions\/workflows\/watch\.yml --jq \.state$/m);
    assert.match(lines, /^api --hostname github\.com repos\/Zeyadigital\/EmDashFleet-Watch\/actions\/workflows\/watch-staging\.yml --jq \.state$/m);
  });

  test("the default remote is the public repository, and the script never forces a push", () => {
    const script = readFileSync(SCRIPT, "utf8");
    assert.match(script, /^remote="https:\/\/github\.com\/Zeyadigital\/EmDashFleet-Watch\.git"$/m);
    assert.doesNotMatch(script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"), /--force|push -f|\+HEAD|--no-verify/);
  });

  test("the commit never uses a guessed identity, on any host", () => {
    // The behavioural test above detects a regression only where git can guess
    // (a hostname with a dot, as macOS .local); an undotted CI host refuses
    // either way, so the option itself is pinned (security audit of 2026-11-21, Watch v06).
    const script = readFileSync(SCRIPT, "utf8");
    const commits = script.split("\n").filter((line) => /^\s*git .* commit /.test(line));
    assert.deepEqual(commits.map((line) => /^git -C "\$repo" -c user\.useConfigOnly=true commit /.test(line)), [true]);
  });
});
