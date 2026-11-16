import type { TelemetryAttributes } from "./core.ts";

/** Fixed labels, highest priority first. A compound command takes its highest-priority segment. */
export const COMMAND_CATEGORIES = ["test", "build", "typecheck", "lint", "format", "install", "boat", "pi", "docker",
	"github", "network", "git", "script", "wait", "file", "search", "read", "shell", "other"] as const;
export type CommandCategory = typeof COMMAND_CATEGORIES[number];
export type CommandClass = { category: CommandCategory; program?: string; runner: "local" | "boat" };

const MAX_INPUT = 50_000, MAX_PROGRAM = 64, MAX_TEXT = 300, MAX_DEPTH = 3;
const sets = (entries: Record<string, string>) => new Map(Object.entries(entries)
	.flatMap(([category, programs]) => programs.split(" ").map((program) => [program, category as CommandCategory])));
const PROGRAMS = sets({
	test: "vitest jest mocha ava tap pytest py.test rspec phpunit playwright cypress karma ctest bats",
	typecheck: "tsc vue-tsc tsgo mypy pyright",
	build: "esbuild vite webpack rollup tsup xcodebuild",
	lint: "eslint oxlint flake8 pylint golangci-lint shellcheck markdownlint stylelint hadolint actionlint",
	format: "prettier black gofmt rustfmt isort dprint",
	install: "pip pip3 brew apt apt-get gem composer",
	pi: "pi",
	docker: "docker docker-compose podman colima kubectl",
	github: "gh",
	network: "curl wget http ssh scp rsync nc",
	wait: "sleep wait",
	file: "mkdir cp mv rm rmdir touch chmod chown ln tar unzip zip gzip gunzip tee truncate mktemp patch",
	search: "rg grep egrep fgrep ag ack find fd ls tree locate du",
	read: "cat head tail less more awk wc jq yq nl sort uniq cut tr diff cmp file stat xxd od column readlink realpath basename dirname shasum md5 sha256sum",
	shell: "command builtin cd export echo printf true false set source . pwd unset local declare read shift exit return trap eval type which alias ulimit umask pushd popd date whoami hostname uname test [ [[ ps kill pkill lsof",
});
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "time", "exec", "nohup"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const INSTALL = new Set(["install", "i", "ci", "add", "update", "upgrade", "uninstall", "remove", "rm", "un", "link"]);
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "python", "python3", "ruby", "perl", "bash", "sh", "zsh"]);

/** Package script, make target or task names. */
function named(name: string | undefined): CommandCategory {
	if (!name) return "build";
	if (/test|spec|e2e|coverage|verif/i.test(name)) return "test";
	if (/typecheck|type-check|types|tsc|check/i.test(name)) return "typecheck";
	if (/lint/i.test(name)) return "lint";
	if (/format|fmt|prettier/i.test(name)) return "format";
	if (/build|compile|bundle|package|dist/i.test(name)) return "build";
	return "script";
}
/** A script file path names its purpose more often than its interpreter does. */
function scriptPath(path: string | undefined): CommandCategory {
	if (path && /(^|[/._-])(tests?|specs?|e2e|verification|verify|checks?)([/._-]|$)/i.test(path)) return "test";
	if (path && /(^|[/._-])build([/._-]|$)/i.test(path)) return "build";
	return "script";
}
const operand = (args: string[]) => args.find((arg) => !arg.startsWith("-"));

/** Splits shell text into simple-command word lists. Quotes, comments, redirections and here-documents never become words. */
export function segments(command: string): string[][] {
	const text = command.slice(0, MAX_INPUT), result: string[][] = [], pending: Array<{ end: string; tabs: boolean }> = [];
	let words: string[] = [], word: string | undefined, target: "skip" | "heredoc" | "heredoc-tabs" | undefined;
	const push = () => {
		if (word === undefined) return;
		if (target === "skip") target = undefined;
		else if (target) { pending.push({ end: word, tabs: target === "heredoc-tabs" }); target = undefined; }
		else words.push(word);
		word = undefined;
	};
	const close = () => { push(); target = undefined; if (words.length) result.push(words); words = []; };
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!, next = text[i + 1];
		if (c === "\\") { if (next !== "\n") word = (word ?? "") + (next ?? ""); i++; }
		else if (c === "'") { const end = text.indexOf("'", i + 1); const stop = end < 0 ? text.length : end; word = (word ?? "") + text.slice(i + 1, stop); i = stop; }
		else if (c === "\"") {
			let value = "";
			for (i++; i < text.length && text[i] !== "\""; i++) value += text[i] === "\\" && i + 1 < text.length ? text[++i] : text[i];
			word = (word ?? "") + value;
		} else if (c === "#" && word === undefined) { while (i + 1 < text.length && text[i + 1] !== "\n") i++; }
		else if (c === " " || c === "\t") push();
		else if (c === "\n") {
			close();
			// Here-document bodies are data, not commands.
			for (const doc of pending.splice(0)) {
				while (i < text.length) {
					const end = text.indexOf("\n", i + 1), stop = end < 0 ? text.length : end;
					const line = text.slice(i + 1, stop);
					i = stop;
					if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) break;
				}
			}
		} else if (c === "<" || c === ">" || (c === "&" && next === ">")) {
			// A file descriptor number belongs to the redirection.
			if (word !== undefined && /^\d+$/.test(word)) word = undefined;
			else push();
			const operator = /^(<<<|<<-|<<|&>>|&>|>>|>&|<&|>\||<>|<|>)/.exec(text.slice(i))![0];
			i += operator.length - 1;
			target = operator === "<<" ? "heredoc" : operator === "<<-" ? "heredoc-tabs" : "skip";
			if ((operator === ">&" || operator === "<&") && /^[\d-]/.test(text[i + 1] ?? "")) { i++; target = undefined; }
		} else if (";&|()".includes(c)) {
			close();
			if ((c === "&" || c === "|" || c === ";") && (next === c || (c === "|" && next === "&"))) i++;
		} else word = (word ?? "") + c;
	}
	close();
	return result;
}

/** Drops assignments, keywords and wrapper programs that only change how the real program runs. */
function unwrap(words: string[]): string[] {
	let rest = words;
	for (;;) {
		const first = rest[0];
		if (first === undefined) return rest;
		const name = first.slice(first.lastIndexOf("/") + 1);
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || KEYWORDS.has(first)) rest = rest.slice(1);
		else if (name === "env" || name === "sudo" || name === "nice" || name === "stdbuf") {
			let i = 1;
			while (i < rest.length && (rest[i]!.startsWith("-") || rest[i]!.includes("="))) i += ["-u", "-n", "-C"].includes(rest[i]!) ? 2 : 1;
			rest = rest.slice(i);
		} else if (name === "timeout") {
			let i = 1;
			while (i < rest.length && rest[i]!.startsWith("-")) i += ["-s", "-k"].includes(rest[i]!) ? 2 : 1;
			rest = rest.slice(i + 1);
		} else if (name === "xargs" || name === "npx" || name === "bunx" || name === "pnpx") {
			let i = 1;
			while (i < rest.length && rest[i]!.startsWith("-")) i += ["-I", "-n", "-P", "-L", "-d", "-E", "-p", "--package"].includes(rest[i]!) ? 2 : 1;
			rest = rest.slice(i);
		} else return rest;
	}
}

const OPTION_VALUES = new Set(["--prefix", "-C", "-w", "--workspace", "--filter", "-F", "--cwd", "--dir"]);
function packageManager(manager: string, args: string[], depth: number): CommandClass | CommandCategory {
	const index = args.findIndex((arg, i) => !arg.startsWith("-") && !OPTION_VALUES.has(args[i - 1] ?? ""));
	const sub = args[index], rest = args.slice(index + 1);
	if (sub === undefined) return manager === "yarn" ? "install" : "other";
	if (["test", "t", "tst"].includes(sub)) return "test";
	if (["run", "run-script", "rum", "urn"].includes(sub)) {
		const name = operand(rest);
		return manager === "bun" && name && /\.[cm]?[jt]sx?$/.test(name) ? scriptPath(name) : named(name);
	}
	if (INSTALL.has(sub)) return "install";
	if (["exec", "x", "dlx"].includes(sub)) return classifyWords(rest[0] === "--" ? rest.slice(1) : rest, depth + 1);
	if (manager === "npm") return sub === "start" ? "script" : "other";
	// Other managers also run package binaries by name.
	const binary = classifyWords([sub, ...rest], depth + 1);
	return binary.category === "other" ? named(sub) : binary;
}

function interpreter(name: string, args: string[], depth: number): CommandClass | CommandCategory {
	if (name === "node" && args.includes("--test")) return "test";
	if ((name === "python" || name === "python3") && args[0] === "-m") {
		const module = args[1];
		return module === "pytest" || module === "unittest" ? "test" : module === "pip" ? "install" : "script";
	}
	const shell = ["bash", "sh", "zsh"].includes(name);
	const inline = args.findIndex((arg) => shell ? /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg) : ["-e", "--eval", "-p", "--print", "-c"].includes(arg));
	if (inline >= 0) return shell ? classifyText(args[inline + 1] ?? "", depth + 1) : "script";
	return scriptPath(operand(args));
}

function boat(name: string, args: string[], depth: number): CommandClass | CommandCategory {
	if (name === "boat-run") return args[0] === "run" ? named(args[1]) : "boat";
	const sub = operand(args), separator = args.indexOf("--");
	if (sub && ["exec", "ssh", "run"].includes(sub) && separator >= 0 && separator + 1 < args.length) {
		return classifyWords(args.slice(separator + 1), depth + 1);
	}
	return "boat";
}

function program(name: string, args: string[], depth: number): CommandClass | CommandCategory {
	const sub = operand(args);
	if (PACKAGE_MANAGERS.has(name)) return name === "bun" && sub === "test" ? "test" : packageManager(name, args, depth);
	if (INTERPRETERS.has(name)) return interpreter(name, args, depth);
	if (name === "boat" || name === "boat-run") return boat(name, args, depth);
	if (name === "git") return sub === "grep" ? "search" : "git";
	if (name === "sed") return args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place")) ? "file" : "read";
	if (name === "make" || name === "gmake" || name === "just" || name === "task") {
		const target = args.find((arg, i) => !arg.startsWith("-") && !arg.includes("=") && args[i - 1] !== "-C" && args[i - 1] !== "-f");
		return named(target);
	}
	if (name === "go") return sub === "test" ? "test" : sub === "vet" ? "lint" : sub === "fmt" ? "format" : sub === "mod" || sub === "get" ? "install" : sub === "run" ? "script" : "build";
	if (name === "cargo") return ({ test: "test", nextest: "test", check: "typecheck", clippy: "lint", fmt: "format", fetch: "install", add: "install", install: "install", run: "script" } as Record<string, CommandCategory>)[sub ?? ""] ?? "build";
	if (name === "deno") return ({ test: "test", lint: "lint", fmt: "format", check: "typecheck", install: "install", add: "install" } as Record<string, CommandCategory>)[sub ?? ""] ?? scriptPath(args.find((arg, i) => i > 0 && !arg.startsWith("-")));
	if (name === "gradle" || name === "gradlew" || name === "mvn" || name === "mvnw") return args.some((arg) => /test|check|verify/i.test(arg)) ? "test" : "build";
	if (name === "dotnet" || name === "swift") return sub === "test" ? "test" : sub === "restore" ? "install" : sub === "format" ? "format" : "build";
	if (name === "turbo" || name === "nx") return named(sub === "run" ? operand(args.slice(args.indexOf("run") + 1)) : sub);
	if (name === "uv" || name === "poetry" || name === "bundle") {
		if (sub === "run" || sub === "exec") return classifyWords(args.slice(args.indexOf(sub) + 1), depth + 1);
		return sub === "pip" || INSTALL.has(sub ?? "") || sub === "sync" || sub === "lock" ? "install" : "other";
	}
	if (name === "biome") return sub === "format" ? "format" : "lint";
	if (name === "ruff") return sub === "format" ? "format" : "lint";
	if (name === "vite" || name === "webpack" || name === "rollup") return sub === "build" || name !== "vite" ? "build" : "script";
	return PROGRAMS.get(name) ?? "other";
}

function classifyWords(input: string[], depth: number): CommandClass {
	const words = unwrap(input), first = words[0];
	if (first === undefined) return { category: "other", program: undefined, runner: "local" };
	const name = first.slice(first.lastIndexOf("/") + 1);
	const found = depth > MAX_DEPTH ? "other" : program(name, words.slice(1), depth);
	const result: CommandClass = typeof found === "string" ? { category: found, program: name.slice(0, MAX_PROGRAM), runner: "local" } : { ...found };
	if (name === "boat" || name === "boat-run") result.runner = "boat";
	return result;
}

function classifyText(command: string, depth: number): CommandClass {
	let best: CommandClass = { category: "other", program: undefined, runner: "local" };
	for (const words of segments(command)) {
		const found = classifyWords(words, depth);
		if (COMMAND_CATEGORIES.indexOf(found.category) < COMMAND_CATEGORIES.indexOf(best.category)
			|| (best.program === undefined && found.category === best.category)) best = found;
	}
	return best;
}

export function classifyCommand(command: string): CommandClass {
	return classifyText(command, 0);
}

/** Opt-in text keeps a bounded prefix and masks common credential forms. */
export function redactCommand(command: string): string {
	return command.trim()
		.replace(/(\w+:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@")
		.replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]")
		.replace(/\b([A-Za-z0-9_]*(?:token|secret|password|passwd|api_?key|access_key)[A-Za-z0-9_]*)=\S+/gi, "$1=[redacted]")
		.replace(/(--?(?:password|token|secret|api-key|apikey)[= ])\S+/gi, "$1[redacted]")
		.replace(/(\s-u\s+)\S+:\S+/g, "$1[redacted]")
		.slice(0, MAX_TEXT);
}

/** Bash calls get fixed labels. The command text is recorded only when SLATE_TELEMETRY_COMMAND_TEXT=1. */
export function commandAttributes(toolName: string, args: unknown, includeText = process.env.SLATE_TELEMETRY_COMMAND_TEXT === "1"): TelemetryAttributes {
	const command = toolName === "bash" && typeof args === "object" && args !== null ? (args as { command?: unknown }).command : undefined;
	if (typeof command !== "string") return {};
	const found = classifyCommand(command);
	return { "slate.command.category": found.category, "slate.command.runner": found.runner, "slate.command.program": found.program,
		"slate.command.text": includeText ? redactCommand(command) : undefined };
}
