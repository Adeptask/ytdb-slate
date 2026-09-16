# Adeptask fork maintenance

This repository has an Adeptask fork that keeps local model-provider profiles. The fork also receives changes from `JetBrains/ytdb-slate:main` through `.github/workflows/upstream-sync.yml`.

## Preserved fork work

The fork-only provider work currently changes these files:

- `docs/context-budget.md`
- `docs/model-routing.md`
- `extension/mode.ts`
- `extension/model-profiles.ts`
- `test/doctrine-contract.test.ts`
- `test/router-price-routing.test.ts`
- `verification/README.md`
- `verification/resolver-checks.mjs`

The sync creates a normal merge commit. Its first parent is the exact Adeptask `main` tip. Its second parent is the exact JetBrains `main` tip. The workflow never resets or rebases the fork.

Publication uses an exact expected-base lease. The lease permits the update only while remote `main` still equals the recorded first parent. The helper separately proves that the candidate descends from that same parent.

## Schedule and manual runs

The workflow has a daily schedule and a manual `workflow_dispatch` trigger. Every effective job also requires the exact repository identity `Adeptask/ytdb-slate`. A copied workflow in another fork skips all jobs.

A manually disabled GitHub workflow stays disabled until a repository operator enables it. Enable this workflow only after the manual smoke checks below pass.

When the recorded upstream tip is already in the fork history, preparation reports a no-op. The validation and publication jobs do not run.

## Authority separation

The workflow has three stages.

1. **Prepare.** A read-only job checks that fork `main` still equals the workflow revision. It creates one two-parent merge from the recorded fork and upstream tips. It stops on a conflict or a protected control-path change. It uploads one Git bundle, one strict manifest, and one copy of the trusted helper.
2. **Validate.** Two jobs download the original artifact by its immutable artifact identifier. They verify external SHA-256 hashes and exact Git topology. They then check out and execute the candidate on Node 22.23.1 and Node 24.18.0. They have no repository write permission, persisted checkout credential, secret, or shared dependency cache.
3. **Publish.** A separate job downloads the original preparation artifact again. It verifies the same hashes, manifest, commit, tree, and parent order. It never checks out or executes candidate files. It fetches both live `main` refs. It then updates fork `main` with an exact expected-base lease for the verified first parent.

Successful scheduled and manual runs update `main` directly. The workflow does not create a pull request.

The protected control paths are `.github/workflows/**` and `verification/upstream-sync-check.mjs`. An upstream change to either path needs a separate reviewed fork update. The trusted helper rejects that change before candidate code runs.

GitHub artifact version 4 stores immutable artifacts. Preparation passes the unique artifact identifier and artifact digest to later jobs. The helper also passes bundle, manifest, and helper hashes outside the artifact. Before either later job executes the downloaded helper, trusted inline code requires exactly three top-level regular files: `candidate.bundle`, `manifest.json`, and `trusted-helper.mjs`. A symlink, directory, nested entry, extra file, hash mismatch, malformed manifest, unexpected ref, wrong parent, wrong tree, or extra bundle head stops the run.

## Validation contract

Each validation job runs the same checks as the repository CI workflow:

```text
npm ci --ignore-scripts
npm run typecheck
bash verification/run-packaging-checks.sh --repo .
bash verification/run-packaging-checks.sh --repo . --self-test
bash verification/run-load-check.sh --repo .
bash verification/run-resolver-checks.sh --repo . --strict
npm test -- --base <recorded-fork-main-sha>
```

Automatic publication requires exactly one final `RUN VERDICT: PASS — ...` line. `WARN`, `FAIL`, `ERROR`, a missing verdict, and multiple verdicts stop publication.

The checks assume that the JetBrains upstream repository is trusted. The workflow isolates candidate execution from repository write authority. It does not claim that tests can prove useful behavior against an upstream maintainer who intentionally changes the tests to accept faulty code.

## Races and follow-on CI

The publisher checks both remote tips immediately before it pushes. The push also carries an exact expected-base lease. Any change to fork `main` after the check rejects the update atomically. This includes a descendant update, an ancestor rewind, deletion, the upstream parent, an unrelated commit, and the candidate already published by another writer. The lease is not permission to overwrite divergent work. The verified candidate must descend from the exact expected base before the helper can attempt the update.

The publisher also stops when it observes a new upstream tip. Git cannot atomically compare a ref in the JetBrains repository while it updates a ref in the Adeptask repository. An upstream update after the final read can therefore leave the fork one tip behind. It cannot add untested content or remove fork history. The next scheduled or manual run picks it up.

A push made with the repository `GITHUB_TOKEN` does not start another push workflow run. The two validation jobs are therefore the authoritative pre-push checks for the merge candidate.

## Failure and recovery

- **Merge conflict:** No artifact is uploaded. Resolve the conflict in a normal reviewed fork commit, then run the workflow again.
- **Protected path changed:** Review and apply the control-file update separately. Do not weaken or bypass the protected-path rule.
- **Validation failed:** Inspect the failed Node leg. Fix the fork or wait for an upstream correction. Re-run from a fresh fork tip.
- **Fork or observed upstream race:** Run the workflow again. Preparation records the new tips.
- **Hash, manifest, or topology failure:** Treat the artifact as invalid. Do not publish it. Start a new run.
- **No-op:** No recovery is needed. The recorded upstream tip is already in fork history.

Never recover by resetting fork `main`, reusing an old artifact, or manually pushing the unverified candidate commit. Never use a force command outside the helper's exact expected-base lease.

## Install a verified fork commit

Install a reviewed Adeptask commit into a trusted project with a pinned project-local Git source:

```bash
pi install -l git:github.com/Adeptask/ytdb-slate@<verified-commit-sha>
```

Pi records the source in the project's `.pi/settings.json`. Pi stores a project-local Git package under `.pi/git/`. The commit pin does not move when you run `pi update --extensions` or `pi update --all`.

After a later sync commit is reviewed, replace the pin explicitly:

```bash
pi install -l git:github.com/Adeptask/ytdb-slate@<new-verified-commit-sha>
```

Review the new source before installation because Pi packages run with full system access. Restart Pi after changing the package pin. Do not use the npm install command for an unpublished fork commit.

## Enablement smoke checks

Keep remote publication disabled until a repository operator has reviewed the committed workflow and completed these checks:

1. Run `node --test test/upstream-sync-check.test.ts` locally.
2. Confirm a manual run reports a clean no-op when upstream is already present.
3. In a disposable fork or equivalent test repository, confirm a clean merge publishes only after both Node legs pass.
4. Confirm a synthetic conflict, protected-path change, check failure, and fork race publish nothing.
5. Confirm an observed upstream race stops, while an upstream move after the final read waits for the next run without changing the tested candidate.

Remote enablement and dispatch are operator actions. They are not part of the implementation commit.
