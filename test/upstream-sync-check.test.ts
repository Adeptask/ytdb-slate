import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

// The shipped helper is plain JavaScript because GitHub Actions executes it directly.
// @ts-expect-error The project does not generate declarations for verification commands.
import { prepareCandidate, publishCandidate, requirePassVerdict, sha256File, verifyCandidate } from "../verification/upstream-sync-check.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_SOURCE = join(REPO_ROOT, "verification", "upstream-sync-check.mjs");
const WORKFLOW_SOURCE = join(REPO_ROOT, ".github", "workflows", "upstream-sync.yml");

interface Fixture {
  root: string;
  seed: string;
  fork: string;
  upstream: string;
  base: string;
  common: string;
  upstreamTip: string;
  artifact: string;
  result?: Record<string, string | number | boolean | string[]>;
}

function command(cwd: string, executable: string, args: string[]) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 20_000 });
  assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout.trim();
}

function git(cwd: string, ...args: string[]) {
  return command(cwd, "git", args);
}

function write(repo: string, path: string, content: string) {
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function commitAll(repo: string, message: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function cloneWork(root: string, remote: string, name: string) {
  const path = join(root, name);
  git(root, "clone", "-q", remote, path);
  git(path, "config", "user.name", "Sync Test");
  git(path, "config", "user.email", "sync@example.invalid");
  return path;
}

function fixture(t: { after(fn: () => void): void }, options: { conflict?: boolean; protectedPath?: string; noOp?: boolean } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "slate-upstream-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.name", "Sync Test");
  git(seed, "config", "user.email", "sync@example.invalid");
  write(seed, "shared.txt", "common\n");
  const common = commitAll(seed, "common");
  const fork = join(root, "fork.git");
  const upstream = join(root, "upstream.git");
  git(root, "clone", "-q", "--bare", seed, fork);
  git(root, "clone", "-q", "--bare", seed, upstream);

  const forkWork = cloneWork(root, fork, "fork-work");
  write(forkWork, "fork.txt", "preserved fork work\n");
  if (options.conflict) write(forkWork, "shared.txt", "fork value\n");
  const base = commitAll(forkWork, "fork work");
  git(forkWork, "push", "-q", "origin", "main");

  let upstreamTip = common;
  if (!options.noOp) {
    const upstreamWork = cloneWork(root, upstream, "upstream-work");
    if (options.conflict) write(upstreamWork, "shared.txt", "upstream value\n");
    else if (options.protectedPath) write(upstreamWork, options.protectedPath, "changed control\n");
    else write(upstreamWork, "upstream.txt", "new upstream work\n");
    upstreamTip = commitAll(upstreamWork, "upstream work");
    git(upstreamWork, "push", "-q", "origin", "main");
  }

  const artifact = join(root, "artifact");
  return { root, seed, fork, upstream, base, common, upstreamTip, artifact };
}

function prepare(f: Fixture) {
  const repo = cloneWork(f.root, f.fork, `prepare-${Math.random().toString(16).slice(2)}`);
  git(repo, "remote", "add", "upstream", f.upstream);
  git(repo, "fetch", "-q", "upstream", "main");
  const result = prepareCandidate({ repo, baseRef: f.base, upstreamRef: f.upstreamTip, outputDir: f.artifact });
  if (result.changed) copyFileSync(HELPER_SOURCE, join(f.artifact, "trusted-helper.mjs"));
  f.result = result as unknown as Record<string, string | number | boolean | string[]>;
  return result;
}

function verification(f: Fixture) {
  assert.ok(f.result);
  return {
    bundlePath: join(f.artifact, "candidate.bundle"),
    manifestPath: join(f.artifact, "manifest.json"),
    bundleSha256: String(f.result.bundleSha256),
    manifestSha256: String(f.result.manifestSha256),
    expected: {
      base: String(f.result.base),
      upstream: String(f.result.upstream),
      candidate: String(f.result.candidate),
      tree: String(f.result.tree),
    },
  };
}

function advance(remote: string, root: string, name: string, path: string) {
  const work = cloneWork(root, remote, name);
  write(work, path, `${name}\n`);
  const tip = commitAll(work, name);
  git(work, "push", "-q", "origin", "main");
  return tip;
}

function workflowBootstrap(job: "validate" | "publish") {
  const workflow = readFileSync(WORKFLOW_SOURCE, "utf8");
  const start = workflow.indexOf(`  ${job}:`);
  const end = job === "validate" ? workflow.indexOf("  publish:", start) : workflow.length;
  assert.ok(start >= 0 && end > start, `${job} job is missing`);
  const block = workflow.slice(start, end);
  const match = block.match(/node --input-type=module - "\$artifact" <<'NODE'\n([\s\S]*?)\n          NODE/);
  assert.ok(match, `${job} bootstrap is missing`);
  return match[1]!.replace(/^ {10}/gm, "");
}

function runWorkflowBootstrap(script: string, artifact: string, marker: string) {
  const bootstrap = spawnSync(process.execPath, ["--input-type=module", "-", artifact], {
    input: script,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (bootstrap.status === 0) {
    spawnSync(process.execPath, [join(artifact, "trusted-helper.mjs"), marker], {
      encoding: "utf8",
      timeout: 20_000,
    });
  }
  return { status: bootstrap.status, helperRan: existsSync(marker), stderr: bootstrap.stderr };
}

test("clean merge produces one exact two-parent candidate and checkout", (t) => {
  const f = fixture(t);
  const result = prepare(f);
  assert.equal(result.changed, true);
  const checkoutDir = join(f.root, "candidate-checkout");
  const manifest = verifyCandidate({ ...verification(f), checkoutDir });
  assert.equal(manifest.base, f.base);
  assert.equal(manifest.upstream, f.upstreamTip);
  assert.equal(readFileSync(join(checkoutDir, "fork.txt"), "utf8"), "preserved fork work\n");
  assert.equal(readFileSync(join(checkoutDir, "upstream.txt"), "utf8"), "new upstream work\n");
  assert.deepEqual(git(checkoutDir, "show", "-s", "--format=%P", "HEAD").split(" "), [f.base, f.upstreamTip]);
});

test("no-op returns without creating an artifact", (t) => {
  const f = fixture(t, { noOp: true });
  const result = prepare(f);
  assert.equal(result.changed, false);
  assert.equal(result.upstream, f.common);
  assert.equal(spawnSync("test", ["-e", f.artifact]).status, 1);
});

test("merge conflict and protected control change stop preparation", async (t) => {
  await t.test("conflict", (t) => {
    const f = fixture(t, { conflict: true });
    assert.throws(() => prepare(f), /merge has conflicts/i);
  });
  await t.test("workflow change", (t) => {
    const f = fixture(t, { protectedPath: ".github/workflows/ci.yml" });
    assert.throws(() => prepare(f), /protected control path.*\.github\/workflows\/ci\.yml/i);
  });
  await t.test("trusted helper change", (t) => {
    const f = fixture(t, { protectedPath: "verification/upstream-sync-check.mjs" });
    assert.throws(() => prepare(f), /protected control path.*verification\/upstream-sync-check\.mjs/i);
  });
});

test("malformed manifest and artifact mutation fail closed", async (t) => {
  await t.test("malformed manifest", (t) => {
    const f = fixture(t);
    prepare(f);
    writeFileSync(join(f.artifact, "manifest.json"), "{not json\n");
    const input = verification(f);
    input.manifestSha256 = sha256File(input.manifestPath);
    assert.throws(() => verifyCandidate(input), /manifest is not valid JSON/i);
  });
  await t.test("mutated bundle", (t) => {
    const f = fixture(t);
    prepare(f);
    appendFileSync(join(f.artifact, "candidate.bundle"), "mutation");
    assert.throws(() => verifyCandidate(verification(f)), /bundle SHA-256 differs/i);
  });
  await t.test("bundle with missing objects", (t) => {
    const f = fixture(t);
    prepare(f);
    const input = verification(f);
    const bytes = readFileSync(input.bundlePath);
    writeFileSync(input.bundlePath, bytes.subarray(0, Math.floor(bytes.length / 2)));
    input.bundleSha256 = sha256File(input.bundlePath);
    assert.throws(() => verifyCandidate(input), /git (bundle|fetch)|bundle does not contain/i);
  });
});

test("artifact identity and exact top-level topology fail closed", async (t) => {
  await t.test("trusted candidate binding", (t) => {
    const f = fixture(t);
    prepare(f);
    const input = verification(f);
    input.expected.candidate = input.expected.base;
    assert.throws(() => verifyCandidate(input), /manifest candidate differs from the trusted prepare output/i);
  });
  await t.test("stale manifest digest", (t) => {
    const f = fixture(t);
    prepare(f);
    appendFileSync(join(f.artifact, "manifest.json"), " \n");
    assert.throws(() => verifyCandidate(verification(f)), /manifest SHA-256 differs/i);
  });
  for (const kind of ["extra file", "nested directory", "helper symlink"] as const) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      prepare(f);
      if (kind === "extra file") writeFileSync(join(f.artifact, "unexpected-file"), "unexpected\n");
      if (kind === "nested directory") mkdirSync(join(f.artifact, "nested"));
      if (kind === "helper symlink") {
        rmSync(join(f.artifact, "trusted-helper.mjs"));
        symlinkSync(HELPER_SOURCE, join(f.artifact, "trusted-helper.mjs"));
      }
      assert.throws(() => verifyCandidate(verification(f)), /artifact (file roster differs|file .* must be a regular file)/i);
    });
  }
});

test("bad declared ancestry is rejected before bundle use", (t) => {
  const f = fixture(t);
  prepare(f);
  const input = verification(f);
  const unrelated = git(f.seed, "commit-tree", git(f.seed, "rev-parse", "HEAD^{tree}"), "-m", "unrelated");
  const manifest = JSON.parse(readFileSync(input.manifestPath, "utf8"));
  manifest.base = unrelated;
  writeFileSync(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  input.manifestSha256 = sha256File(input.manifestPath);
  input.expected.base = unrelated;
  assert.throws(() => verifyCandidate(input), /fork base first and upstream tip second/i);
});

test("wrong parent order is rejected even when all external hashes match", (t) => {
  const f = fixture(t);
  prepare(f);
  const input = verification(f);
  const build = cloneWork(f.root, f.fork, "wrong-parent-work");
  git(build, "fetch", "-q", f.upstream, "main");
  git(build, "fetch", "-q", input.bundlePath, "refs/heads/upstream-sync-candidate:refs/heads/original-candidate");
  const tree = git(build, "rev-parse", `${input.expected.candidate}^{tree}`);
  const result = spawnSync("git", ["-C", build, "commit-tree", tree, "-p", f.upstreamTip, "-p", f.base], {
    input: "wrong order\n",
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Sync Test", GIT_AUTHOR_EMAIL: "sync@example.invalid", GIT_COMMITTER_NAME: "Sync Test", GIT_COMMITTER_EMAIL: "sync@example.invalid" },
  });
  assert.equal(result.status, 0, result.stderr);
  const wrong = result.stdout.trim();
  git(build, "update-ref", "refs/heads/upstream-sync-candidate", wrong);
  git(build, "bundle", "create", input.bundlePath, "refs/heads/upstream-sync-candidate");
  const manifest = JSON.parse(readFileSync(input.manifestPath, "utf8"));
  manifest.candidate = wrong;
  writeFileSync(input.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  input.bundleSha256 = sha256File(input.bundlePath);
  input.manifestSha256 = sha256File(input.manifestPath);
  input.expected.candidate = wrong;
  assert.throws(() => verifyCandidate(input), /fork base first and upstream tip second/i);
});

test("publisher rejects an already observed fork race", (t) => {
  const f = fixture(t);
  prepare(f);
  advance(f.fork, f.root, "fork-race", "fork-race.txt");
  assert.throws(() => publishCandidate({ ...verification(f), forkUrl: f.fork, upstreamUrl: f.upstream }), /fork main moved/i);
});

test("exact-base lease accepts an unchanged fork and rejects every late main race", async (t) => {
  await t.test("unchanged exact base", (t) => {
    const f = fixture(t);
    prepare(f);
    const manifest = publishCandidate({ ...verification(f), forkUrl: f.fork, upstreamUrl: f.upstream });
    assert.equal(git(f.fork, "rev-parse", "main"), manifest.candidate);
  });

  for (const kind of ["descendant", "ancestor rewind", "deletion", "upstream parent", "unrelated", "already published"] as const) {
    await t.test(kind, (t) => {
      const f = fixture(t);
      prepare(f);
      const candidate = String(f.result?.candidate);
      const input = verification(f);
      const move = () => {
        if (kind === "descendant") {
          advance(f.fork, f.root, "late-descendant", "late-descendant.txt");
        } else if (kind === "ancestor rewind") {
          git(f.fork, "update-ref", "refs/heads/main", f.common);
        } else if (kind === "deletion") {
          git(f.fork, "update-ref", "-d", "refs/heads/main");
        } else if (kind === "upstream parent") {
          git(f.fork, "fetch", "-q", f.upstream, `${f.upstreamTip}:refs/heads/race-source`);
          git(f.fork, "update-ref", "refs/heads/main", f.upstreamTip);
        } else if (kind === "unrelated") {
          const unrelated = git(f.seed, "commit-tree", git(f.seed, "rev-parse", "HEAD^{tree}"), "-m", "unrelated race");
          git(f.fork, "fetch", "-q", f.seed, `${unrelated}:refs/heads/race-source`);
          git(f.fork, "update-ref", "refs/heads/main", unrelated);
        } else {
          git(f.fork, "fetch", "-q", input.bundlePath, "refs/heads/upstream-sync-candidate:refs/heads/race-source");
          git(f.fork, "update-ref", "refs/heads/main", candidate);
        }
      };
      assert.throws(() => publishCandidate({
        ...input,
        forkUrl: f.fork,
        upstreamUrl: f.upstream,
        beforePush: move,
      }), /git push failed|fork main changed to the candidate/i);

      if (kind === "deletion") {
        assert.notEqual(spawnSync("git", ["-C", f.fork, "rev-parse", "--verify", "refs/heads/main"]).status, 0);
      } else {
        assert.notEqual(git(f.fork, "rev-parse", "main"), kind === "already published" ? f.base : candidate);
      }

      if (kind === "already published") {
        const fresh = cloneWork(f.root, f.fork, "fresh-no-op");
        git(fresh, "remote", "add", "upstream", f.upstream);
        git(fresh, "fetch", "-q", "upstream", "main");
        const recovered = prepareCandidate({
          repo: fresh,
          baseRef: "refs/remotes/origin/main",
          upstreamRef: "refs/remotes/upstream/main",
          outputDir: join(f.root, "fresh-artifact"),
        });
        assert.equal(recovered.changed, false, "a fresh run recognizes the concurrently published candidate as a no-op");
      }
    });
  }
});

test("publisher rejects an observed upstream race without changing the fork", (t) => {
  const f = fixture(t);
  prepare(f);
  advance(f.upstream, f.root, "upstream-race", "upstream-race.txt");
  assert.throws(() => publishCandidate({ ...verification(f), forkUrl: f.fork, upstreamUrl: f.upstream }), /upstream main moved/i);
  assert.equal(git(f.fork, "rev-parse", "main"), f.base);
});

test("an upstream move after the final read leaves the tested candidate one tip behind", (t) => {
  const f = fixture(t);
  prepare(f);
  let laterUpstream = "";
  const manifest = publishCandidate({
    ...verification(f),
    forkUrl: f.fork,
    upstreamUrl: f.upstream,
    beforePush: () => { laterUpstream = advance(f.upstream, f.root, "late-upstream", "late-upstream.txt"); },
  });
  assert.equal(git(f.fork, "rev-parse", "main"), manifest.candidate);
  git(f.fork, "fetch", "-q", f.upstream, "+refs/heads/main:refs/heads/latest-upstream");
  assert.equal(git(f.fork, "rev-parse", "refs/heads/latest-upstream"), laterUpstream);
  const containsLater = spawnSync("git", ["-C", f.fork, "merge-base", "--is-ancestor", laterUpstream, "main"]);
  assert.equal(containsLater.status, 1);
});

test("workflow keeps candidate execution isolated from publication and rechecks the verdict helper", () => {
  const workflow = readFileSync(WORKFLOW_SOURCE, "utf8");
  const validateStart = workflow.indexOf("  validate:");
  const publishStart = workflow.indexOf("  publish:");
  assert.ok(validateStart >= 0 && publishStart > validateStart);
  const validate = workflow.slice(validateStart, publishStart);
  const publish = workflow.slice(publishStart);

  assert.match(validate, /permissions: \{\}/);
  assert.doesNotMatch(validate, /github\.token|contents: write/);
  assert.match(publish, /needs: \[prepare, validate\]/);
  assert.match(publish, /permissions:\n      contents: write/);
  assert.doesNotMatch(publish, /actions\/checkout|working-directory:.*candidate/);
  assert.equal(workflow.match(/artifact path is not a real directory/g)?.length, 2);
  assert.equal(workflow.match(/const expected = \["candidate\.bundle", "manifest\.json", "trusted-helper\.mjs"\];/g)?.length, 2);

  const bootstrapRoster = validate.indexOf('const expected = ["candidate.bundle", "manifest.json", "trusted-helper.mjs"];');
  const firstHelperHash = validate.indexOf("sha256sum --check --status");
  const firstHelperRun = validate.indexOf('node "$artifact/trusted-helper.mjs" verify');
  const candidateRun = validate.indexOf('npm test -- --base "$BASE"');
  const secondHelperHash = validate.indexOf("sha256sum --check --status", firstHelperHash + 1);
  const verdictRun = validate.indexOf('node "$TRUSTED_HELPER" verdict --log "$log"');
  assert.ok(bootstrapRoster >= 0 && bootstrapRoster < firstHelperHash && firstHelperHash < firstHelperRun);
  assert.ok(candidateRun > firstHelperRun && secondHelperHash > candidateRun && verdictRun > secondHelperHash);
});

test("both exact workflow bootstraps reject bad artifact topology before helper execution", async (t) => {
  for (const job of ["validate", "publish"] as const) {
    await t.test(job, async (t) => {
      const script = workflowBootstrap(job);
      for (const kind of ["valid", "extra file", "nested entry", "directory", "symlink"] as const) {
        await t.test(kind, (t) => {
          const root = mkdtempSync(join(tmpdir(), `slate-${job}-bootstrap-`));
          t.after(() => rmSync(root, { recursive: true, force: true }));
          const artifact = join(root, "artifact");
          const marker = join(root, "helper-ran");
          mkdirSync(artifact);
          writeFileSync(join(artifact, "candidate.bundle"), "candidate\n");
          writeFileSync(join(artifact, "manifest.json"), "{}\n");
          writeFileSync(
            join(artifact, "trusted-helper.mjs"),
            'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "ran\\n");\n',
          );

          if (kind === "extra file") writeFileSync(join(artifact, "unexpected-file"), "unexpected\n");
          if (kind === "nested entry") write(artifact, "nested/entry", "nested\n");
          if (kind === "directory") {
            rmSync(join(artifact, "manifest.json"));
            mkdirSync(join(artifact, "manifest.json"));
          }
          if (kind === "symlink") {
            const helperTarget = join(root, "helper-target.mjs");
            copyFileSync(join(artifact, "trusted-helper.mjs"), helperTarget);
            rmSync(join(artifact, "trusted-helper.mjs"));
            symlinkSync(helperTarget, join(artifact, "trusted-helper.mjs"));
          }

          const result = runWorkflowBootstrap(script, artifact, marker);
          if (kind === "valid") {
            assert.equal(result.status, 0, result.stderr);
            assert.equal(result.helperRan, true, `${job} valid artifact did not reach the helper`);
          } else {
            assert.notEqual(result.status, 0, `${job} accepted ${kind}`);
            assert.equal(result.helperRan, false, `${job} ran the downloaded helper for ${kind}`);
          }
        });
      }
    });
  }
});

test("strict verdict accepts PASS and rejects WARN, FAIL, ERROR, missing, and duplicate lines", (t) => {
  const root = mkdtempSync(join(tmpdir(), "slate-verdict-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = join(root, "test.log");
  writeFileSync(log, "noise\nRUN VERDICT: PASS — accepted\n");
  assert.match(requirePassVerdict(log), /^RUN VERDICT: PASS/);
  for (const text of [
    "RUN VERDICT: WARN — inspect\n",
    "RUN VERDICT: FAIL — rejected\n",
    "RUN VERDICT: ERROR — broken\n",
    "no verdict\n",
    "RUN VERDICT: PASS — one\nRUN VERDICT: PASS — two\n",
  ]) {
    writeFileSync(log, text);
    assert.throws(() => requirePassVerdict(log), /exactly one PASS/i);
  }
});
