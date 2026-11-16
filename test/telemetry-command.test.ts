import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, commandAttributes, redactCommand, segments, COMMAND_CATEGORIES } from "../extension/telemetry/command.ts";

const cases: Array<[string, string, string?, string?]> = [
	// [command, category, program, runner]
	["", "other", undefined],
	["FOO=1", "other", undefined],
	["cd /x && npm test 2>&1 | tail -40", "test", "npm"],
	["npm run typecheck && npm test", "test", "npm"],
	["npm t", "test", "npm"],
	["npm", "other", "npm"],
	["yarn", "install", "yarn"],
	["npm ci", "install", "npm"],
	["npm start", "script", "npm"],
	["npm view x", "other", "npm"],
	["npm run lint", "lint", "npm"],
	["npm run format", "format", "npm"],
	["npm run build", "build", "npm"],
	["npm run check", "typecheck", "npm"],
	["npm run dev", "script", "npm"],
	["npm run", "build", "npm"],
	["npm --prefix tools/boat-run test", "test", "npm"],
	["npm exec -- vitest", "test", "vitest"],
	["npm exec tsc", "typecheck", "tsc"],
	["pnpm --filter app lint", "lint", "pnpm"],
	["pnpm eslint .", "lint", "eslint"],
	["pnpm deploy", "script", "pnpm"],
	["yarn dlx prettier .", "format", "prettier"],
	["bun test", "test", "bun"],
	["bun run scripts/build.ts", "build", "bun"],
	["bun run dev", "script", "bun"],
	["node --test test/a.test.ts", "test", "node"],
	["node -e 'console.log(1)'", "script", "node"],
	["node verification/check.mjs", "test", "node"],
	["node scripts/build/run.mjs", "build", "node"],
	["node tool.mjs", "script", "node"],
	["python3 -m pytest -q", "test", "python3"],
	["python -m pip install x", "install", "python"],
	["python -m http.server", "script", "python"],
	["python3 - <<'EOF'\nimport json\nfor x in y: print(x)\nEOF", "script", "python3"],
	["bash verification/run-tests.sh", "test", "bash"],
	["bash -lc 'cd x && pnpm lint'", "lint", "pnpm"],
	["sh -c", "other", undefined],
	["boat-run run test", "test", "boat-run", "boat"],
	["boat-run status", "boat", "boat-run", "boat"],
	["boat --org=a exec m1 -- npm test", "test", "npm", "boat"],
	["boat exec m1 npm test", "boat", "boat", "boat"],
	["boat exec m1 --", "boat", "boat", "boat"],
	["boat resume m1 --ttl 600", "boat", "boat", "boat"],
	["git status && git diff --stat", "git", "git"],
	["git grep foo", "search", "git"],
	["sed -n 1,80p README.md", "read", "sed"],
	["sed -i '' s/a/b/ f", "file", "sed"],
	["sed --in-place s/a/b/ f", "file", "sed"],
	["make", "build", "make"],
	["make -C sub -f Makefile V=1 test", "test", "make"],
	["just lint", "lint", "just"],
	["go test ./...", "test", "go"],
	["go vet ./...", "lint", "go"],
	["go fmt ./...", "format", "go"],
	["go mod tidy", "install", "go"],
	["go get x", "install", "go"],
	["go run .", "script", "go"],
	["go build", "build", "go"],
	["cargo nextest run", "test", "cargo"],
	["cargo check", "typecheck", "cargo"],
	["cargo clippy", "lint", "cargo"],
	["cargo", "build", "cargo"],
	["deno test", "test", "deno"],
	["deno run -A scripts/test-all.ts", "test", "deno"],
	["deno", "script", "deno"],
	["./gradlew test", "test", "gradlew"],
	["mvn package", "build", "mvn"],
	["dotnet test", "test", "dotnet"],
	["dotnet restore", "install", "dotnet"],
	["dotnet format", "format", "dotnet"],
	["swift build", "build", "swift"],
	["turbo run test", "test", "turbo"],
	["nx lint app", "lint", "nx"],
	["uv run pytest", "test", "pytest"],
	["uv pip install x", "install", "uv"],
	["poetry install", "install", "poetry"],
	["uv sync", "install", "uv"],
	["bundle exec rspec", "test", "rspec"],
	["bundle outdated", "other", "bundle"],
	["biome format .", "format", "biome"],
	["biome check .", "lint", "biome"],
	["ruff format .", "format", "ruff"],
	["ruff check .", "lint", "ruff"],
	["vite build", "build", "vite"],
	["vite", "script", "vite"],
	["webpack", "build", "webpack"],
	["timeout -s KILL -k 5 600 node --test", "test", "node"],
	["env -u HOME A=1 npx -p pkg -y vitest", "test", "vitest"],
	["sudo -u me nice -n 5 stdbuf -oL /usr/bin/pytest", "test", "pytest"],
	["find . -name x | xargs -I {} grep -l y {}", "search", "find"],
	["bunx tsc", "typecheck", "tsc"],
	["for f in a b; do npm test -- $f; done", "test", "npm"],
	["if true; then exec pi -p hi; fi", "pi", "pi"],
	["sleep 30; tail -5 /tmp/log", "wait", "sleep"],
	["command -v jbcontext", "shell", "command"],
	["curl -s http://x | jq .", "network", "curl"],
	["gh pr view 12", "github", "gh"],
	["docker compose up -d", "docker", "docker"],
	["ls -la && echo done", "search", "ls"],
	["mkdir -p a && cat b", "file", "mkdir"],
	["open .", "other", "open"],
	["cat > /tmp/x.ts <<'EOF'\nnpm test\nEOF\nnode /tmp/x.ts", "script", "node"],
];

test("bash commands map to fixed categories, programs and runners", () => {
	for (const [command, category, program, runner = "local"] of cases) {
		assert.deepEqual(classifyCommand(command), { category, program, runner }, command);
		assert.ok(COMMAND_CATEGORIES.includes(classifyCommand(command).category));
	}
	// Nested shells stop at a fixed depth instead of recursing without limit.
	let nested = "npm test";
	for (let i = 0; i < 3; i++) nested = `bash -c ${JSON.stringify(nested)}`;
	assert.equal(classifyCommand(nested).category, "test");
	assert.deepEqual(classifyCommand(`bash -c ${JSON.stringify(nested)}`), { category: "other", program: "npm", runner: "local" });
});

test("shell parsing keeps quoted text, drops redirections, comments and here-document bodies", () => {
	assert.deepEqual(segments("echo 'a b' \"c \\\"d\\\"\" e\\ f # npm test"), [["echo", "a b", "c \"d\"", "e f"]]);
	assert.deepEqual(segments("a 2>&1 >/dev/null &>>log <in >&2 >&- 3<&0 <<<str >|x <>y b"), [["a", "b"]]);
	assert.deepEqual(segments("a\\\nb && c || d ;; e |& f & g"), [["ab"], ["c"], ["d"], ["e"], ["f"], ["g"]]);
	assert.deepEqual(segments("cat <<-END\n\tnpm test\n\tEND\ngit status"), [["cat"], ["git", "status"]]);
	assert.deepEqual(segments("cat <<END\nnpm test"), [["cat"]]);
	assert.deepEqual(segments("diff <(sort a) <(sort b)"), [["diff"], ["sort", "a"], ["sort", "b"]]);
	assert.deepEqual(segments("x\tunterminated 'quote"), [["x", "unterminated", "quote"]]);
	assert.deepEqual(segments("x \"open"), [["x", "open"]]);
	assert.deepEqual(segments("x\\"), [["x"]]);
	assert.equal(segments("x ".repeat(40_000)).flat().length, 25_000);
});

test("opt-in command text masks common credential forms and stays bounded", () => {
	const text = redactCommand(" curl -u me:pw -H 'Authorization: Bearer abcdefgh123' https://u:p@host GH_TOKEN=s3 x --password hunter2 --token=t ");
	assert.equal(text, "curl -u [redacted] -H 'Authorization: Bearer [redacted]' https://[redacted]@host GH_TOKEN=[redacted] x --password [redacted] --token=[redacted]");
	assert.equal(redactCommand("x".repeat(400)).length, 300);
});

test("only bash calls get command attributes, and text needs the opt-in", (t) => {
	assert.deepEqual(commandAttributes("read", { command: "npm test" }), {});
	assert.deepEqual(commandAttributes("bash", null), {});
	assert.deepEqual(commandAttributes("bash", { command: 1 }), {});
	assert.deepEqual(commandAttributes("bash", { command: "npm test" }, false), { "slate.command.category": "test",
		"slate.command.runner": "local", "slate.command.program": "npm", "slate.command.text": undefined });
	assert.equal(commandAttributes("bash", { command: "npm test" }, true)["slate.command.text"], "npm test");
	const before = process.env.SLATE_TELEMETRY_COMMAND_TEXT;
	t.after(() => { if (before === undefined) delete process.env.SLATE_TELEMETRY_COMMAND_TEXT; else process.env.SLATE_TELEMETRY_COMMAND_TEXT = before; });
	process.env.SLATE_TELEMETRY_COMMAND_TEXT = "1";
	assert.equal(commandAttributes("bash", { command: "npm test" })["slate.command.text"], "npm test");
	delete process.env.SLATE_TELEMETRY_COMMAND_TEXT;
	assert.equal(commandAttributes("bash", { command: "npm test" })["slate.command.text"], undefined);
});
