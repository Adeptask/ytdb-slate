#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const CANDIDATE_REF = "refs/heads/upstream-sync-candidate";
const ARTIFACT_FILES = ["candidate.bundle", "manifest.json", "trusted-helper.mjs"];
const PROTECTED_PATHS = [".github/workflows/**", "verification/upstream-sync-check.mjs"];
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = ["base", "candidate", "candidateRef", "protectedPaths", "schemaVersion", "tree", "upstream"];

function fail(message) {
  throw new Error(`upstream-sync: ${message}`);
}

function cleanGitEnv(extra = {}) {
  const env = { ...process.env, ...extra, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.SYNC_TOKEN;
  return env;
}

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? cleanGitEnv(),
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) fail(`${executable} could not start: ${result.error.message}`);
  return result;
}

function git(repo, args, options = {}) {
  const result = command("git", ["-C", repo, ...args], options);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    fail(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function gitStatus(repo, args) {
  return command("git", ["-C", repo, ...args]);
}

function commit(repo, ref) {
  const value = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!SHA1.test(value)) fail(`ref '${ref}' did not resolve to one SHA-1 commit`);
  return value;
}

function regularFile(path, label) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail(`${label} is not readable: ${error.message}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
}

export function sha256File(path) {
  regularFile(path, basename(path));
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifyArtifactDirectory(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    fail(`artifact directory is not readable: ${error.message}`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("artifact path must be a real directory");
  const entries = readdirSync(path).sort();
  if (JSON.stringify(entries) !== JSON.stringify(ARTIFACT_FILES)) {
    fail(`artifact file roster differs from the trusted roster: ${entries.join(", ")}`);
  }
  for (const name of ARTIFACT_FILES) regularFile(join(path, name), `artifact file '${name}'`);
}

function expectSha(value, pattern, label) {
  if (!pattern.test(value)) fail(`${label} is not a valid digest: '${value}'`);
}

function isProtected(path) {
  return path === "verification/upstream-sync-check.mjs" || path === ".github/workflows" || path.startsWith(".github/workflows/");
}

function emptyDirectory(path) {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`output path must be a real directory: ${path}`);
    if (readdirSync(path).length !== 0) fail(`output directory is not empty: ${path}`);
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

function temporaryDirectory(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTemporary(path) {
  rmSync(path, { recursive: true, force: true });
}

function ancestor(repo, older, newer) {
  const result = gitStatus(repo, ["merge-base", "--is-ancestor", older, newer]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail(`git merge-base failed: ${(result.stderr || result.stdout).trim()}`);
}

function manifestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function prepareCandidate({ repo, baseRef, upstreamRef, outputDir }) {
  const source = resolve(repo);
  const base = commit(source, baseRef);
  const upstream = commit(source, upstreamRef);
  if (ancestor(source, upstream, base)) return { changed: false, base, upstream };

  emptyDirectory(outputDir);
  const lab = temporaryDirectory("slate-upstream-prepare-");
  try {
    const bare = join(lab, "objects.git");
    git(lab, ["init", "--bare", bare]);
    git(bare, ["fetch", "--no-tags", source,
      `+${baseRef}:refs/heads/prepared-base`,
      `+${upstreamRef}:refs/heads/prepared-upstream`,
    ]);
    if (commit(bare, "refs/heads/prepared-base") !== base || commit(bare, "refs/heads/prepared-upstream") !== upstream) {
      fail("prepared refs changed while their objects were copied");
    }
    const merge = gitStatus(bare, ["merge-tree", "--write-tree", "--messages", base, upstream]);
    if (merge.status !== 0) {
      const detail = (merge.stdout || merge.stderr || "merge conflict").trim();
      fail(`upstream merge has conflicts: ${detail}`);
    }
    const tree = merge.stdout.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!SHA1.test(tree)) fail("git merge-tree did not return one candidate tree");

    const changedPaths = git(bare, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", base, tree])
      .split("\0").filter(Boolean);
    const protectedChanges = changedPaths.filter(isProtected);
    if (protectedChanges.length > 0) fail(`candidate changes protected control path(s): ${protectedChanges.join(", ")}`);

    const now = new Date().toISOString();
    const candidate = git(bare, ["-c", "commit.gpgSign=false", "commit-tree", tree, "-p", base, "-p", upstream], {
      env: cleanGitEnv({
        GIT_AUTHOR_NAME: "Adeptask upstream sync",
        GIT_AUTHOR_EMAIL: "upstream-sync@users.noreply.github.com",
        GIT_COMMITTER_NAME: "Adeptask upstream sync",
        GIT_COMMITTER_EMAIL: "upstream-sync@users.noreply.github.com",
        GIT_AUTHOR_DATE: now,
        GIT_COMMITTER_DATE: now,
      }),
      input: "Merge JetBrains/ytdb-slate main into Adeptask main\n",
    });
    if (!SHA1.test(candidate)) fail("git commit-tree did not return one candidate commit");
    git(bare, ["update-ref", CANDIDATE_REF, candidate]);

    const bundlePath = join(outputDir, "candidate.bundle");
    git(bare, ["bundle", "create", bundlePath, CANDIDATE_REF]);
    const manifest = {
      schemaVersion: 1,
      base,
      upstream,
      candidate,
      tree,
      candidateRef: CANDIDATE_REF,
      protectedPaths: PROTECTED_PATHS,
    };
    const manifestPath = join(outputDir, "manifest.json");
    writeFileSync(manifestPath, manifestJson(manifest), { encoding: "utf8", mode: 0o600, flag: "wx" });
    return {
      changed: true,
      ...manifest,
      bundleSha256: sha256File(bundlePath),
      manifestSha256: sha256File(manifestPath),
    };
  } finally {
    removeTemporary(lab);
  }
}

function parseManifest(path) {
  regularFile(path, "manifest");
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest must be one JSON object");
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...MANIFEST_KEYS].sort())) fail(`manifest keys differ from the schema: ${keys.join(", ")}`);
  if (value.schemaVersion !== 1) fail(`unsupported manifest schema: ${value.schemaVersion}`);
  for (const key of ["base", "upstream", "candidate", "tree"]) expectSha(value[key], SHA1, `manifest ${key}`);
  if (value.candidateRef !== CANDIDATE_REF) fail(`manifest candidateRef must be ${CANDIDATE_REF}`);
  if (JSON.stringify(value.protectedPaths) !== JSON.stringify(PROTECTED_PATHS)) fail("manifest protected-path policy differs from the trusted policy");
  return value;
}

function verifyExpected(manifest, expected) {
  for (const key of ["base", "upstream", "candidate", "tree"]) {
    expectSha(expected[key], SHA1, `expected ${key}`);
    if (manifest[key] !== expected[key]) fail(`manifest ${key} differs from the trusted prepare output`);
  }
}

function verifyInRepository(repo, bundlePath, manifest) {
  const heads = git(repo, ["bundle", "list-heads", bundlePath]).split(/\r?\n/).filter(Boolean);
  if (heads.length !== 1 || heads[0] !== `${manifest.candidate} ${CANDIDATE_REF}`) fail("bundle does not contain exactly the recorded candidate ref");
  git(repo, ["bundle", "verify", bundlePath]);
  git(repo, ["fetch", "--no-tags", bundlePath, `${CANDIDATE_REF}:refs/heads/verified-candidate`]);
  const candidate = commit(repo, "refs/heads/verified-candidate");
  if (candidate !== manifest.candidate) fail("fetched bundle candidate differs from the manifest");
  const body = git(repo, ["cat-file", "-p", candidate]).split(/\r?\n/);
  const tree = body.find((line) => line.startsWith("tree "))?.slice(5);
  const parents = body.filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
  if (tree !== manifest.tree) fail("candidate tree differs from the manifest");
  if (parents.length !== 2 || parents[0] !== manifest.base || parents[1] !== manifest.upstream) {
    fail("candidate must have exactly the fork base first and upstream tip second");
  }
  if (!ancestor(repo, manifest.base, candidate) || !ancestor(repo, manifest.upstream, candidate)) fail("candidate does not preserve both recorded histories");
}

export function verifyCandidate({ bundlePath, manifestPath, bundleSha256, manifestSha256, expected, checkoutDir }) {
  const artifactDir = dirname(resolve(bundlePath));
  if (dirname(resolve(manifestPath)) !== artifactDir) fail("bundle and manifest must share one artifact directory");
  verifyArtifactDirectory(artifactDir);
  expectSha(bundleSha256, SHA256, "expected bundle SHA-256");
  expectSha(manifestSha256, SHA256, "expected manifest SHA-256");
  if (sha256File(bundlePath) !== bundleSha256) fail("bundle SHA-256 differs from the trusted prepare output");
  if (sha256File(manifestPath) !== manifestSha256) fail("manifest SHA-256 differs from the trusted prepare output");
  const manifest = parseManifest(manifestPath);
  verifyExpected(manifest, expected);

  const lab = temporaryDirectory("slate-upstream-verify-");
  try {
    const bare = join(lab, "verify.git");
    git(lab, ["init", "--bare", bare]);
    verifyInRepository(bare, bundlePath, manifest);
  } finally {
    removeTemporary(lab);
  }

  if (checkoutDir) {
    if (existsSync(checkoutDir)) fail(`checkout path already exists: ${checkoutDir}`);
    mkdirSync(checkoutDir, { recursive: false, mode: 0o700 });
    git(checkoutDir, ["init", "--quiet"]);
    git(checkoutDir, ["config", "core.hooksPath", "/dev/null"]);
    git(checkoutDir, ["fetch", "--no-tags", bundlePath, `${CANDIDATE_REF}:refs/heads/verified-candidate`]);
    git(checkoutDir, ["checkout", "--quiet", "--detach", manifest.candidate]);
    const checkedOut = commit(checkoutDir, "HEAD");
    if (checkedOut !== manifest.candidate) fail("checked-out candidate differs from the verified commit");
  }
  return manifest;
}

export function requirePassVerdict(logPath) {
  regularFile(logPath, "test log");
  const lines = readFileSync(logPath, "utf8").split(/\r?\n/).filter((line) => line.startsWith("RUN VERDICT:"));
  if (lines.length !== 1 || !lines[0].startsWith("RUN VERDICT: PASS —")) {
    fail(`test log must contain exactly one PASS run verdict, observed: ${lines.length === 0 ? "none" : lines.join(" | ")}`);
  }
  return lines[0];
}

function remoteTip(repo, url, namespace) {
  git(repo, ["fetch", "--no-tags", "--force", url, `+refs/heads/main:refs/remotes/${namespace}/main`]);
  return commit(repo, `refs/remotes/${namespace}/main`);
}

export function publishCandidate(options) {
  const manifest = verifyCandidate(options);
  const lab = temporaryDirectory("slate-upstream-publish-");
  try {
    const bare = join(lab, "publish.git");
    git(lab, ["init", "--bare", bare]);
    const forkTip = remoteTip(bare, options.forkUrl, "fork");
    if (forkTip !== manifest.base) fail(`fork main moved from ${manifest.base} to ${forkTip}`);
    const upstreamTip = remoteTip(bare, options.upstreamUrl, "upstream");
    if (upstreamTip !== manifest.upstream) fail(`upstream main moved from ${manifest.upstream} to ${upstreamTip}`);
    git(bare, ["fetch", "--no-tags", options.bundlePath, `${CANDIDATE_REF}:refs/heads/verified-candidate`]);
    verifyInRepository(bare, options.bundlePath, manifest);
    if (options.beforePush) options.beforePush({ manifest, bare });

    const extra = {};
    if (options.token) {
      const authorization = Buffer.from(`x-access-token:${options.token}`).toString("base64");
      extra.GIT_CONFIG_COUNT = "1";
      extra.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
      extra.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${authorization}`;
    }
    const pushed = git(bare, [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/main:${manifest.base}`,
      options.forkUrl,
      `${manifest.candidate}:refs/heads/main`,
    ], { env: cleanGitEnv(extra) });
    if (/\[up to date\]/i.test(pushed)) fail("fork main changed to the candidate before the leased update");
    return manifest;
  } finally {
    removeTemporary(lab);
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail(`invalid argument near '${name ?? ""}'`);
    if (Object.hasOwn(values, name)) fail(`duplicate argument '${name}'`);
    values[name] = value;
  }
  return values;
}

function required(values, name) {
  const value = values[name];
  if (!value) fail(`missing ${name}`);
  return value;
}

function verificationOptions(values) {
  return {
    bundlePath: required(values, "--bundle"),
    manifestPath: required(values, "--manifest"),
    bundleSha256: required(values, "--bundle-sha256"),
    manifestSha256: required(values, "--manifest-sha256"),
    expected: {
      base: required(values, "--base"),
      upstream: required(values, "--upstream"),
      candidate: required(values, "--candidate"),
      tree: required(values, "--tree"),
    },
  };
}

function usage() {
  return "usage: upstream-sync-check.mjs <prepare|verify|verdict|publish> [options]";
}

function main() {
  const [operation, ...argv] = process.argv.slice(2);
  const values = parseArgs(argv);
  if (operation === "prepare") {
    const result = prepareCandidate({
      repo: required(values, "--repo"),
      baseRef: required(values, "--base-ref"),
      upstreamRef: required(values, "--upstream-ref"),
      outputDir: required(values, "--output-dir"),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (operation === "verify") {
    const options = verificationOptions(values);
    if (values["--checkout-dir"]) options.checkoutDir = values["--checkout-dir"];
    const manifest = verifyCandidate(options);
    process.stdout.write(`upstream-sync: verified ${manifest.candidate}\n`);
    return;
  }
  if (operation === "verdict") {
    process.stdout.write(`${requirePassVerdict(required(values, "--log"))}\n`);
    return;
  }
  if (operation === "publish") {
    const tokenName = required(values, "--token-env");
    const token = process.env[tokenName];
    if (!token) fail(`token environment variable '${tokenName}' is empty`);
    const manifest = publishCandidate({
      ...verificationOptions(values),
      forkUrl: required(values, "--fork-url"),
      upstreamUrl: required(values, "--upstream-url"),
      token,
    });
    process.stdout.write(`upstream-sync: published ${manifest.candidate}\n`);
    return;
  }
  fail(operation ? `unknown operation '${operation}'` : usage());
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
