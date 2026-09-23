import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { findProfile, ladderFor, MODEL_PROFILES, type ModelProfile, type PriceRow, type ThinkingLevel } from "../extension/model-profiles.ts";
import {
  checkEffort,
  coveringPriceRow,
  isValidPrice,
  resolveModelRouter,
  type ModelRouterResolution,
  type RouterProfileSource,
  type RouterRegistry,
  type RouterRegistryModel,
  type RouterWarningClass,
} from "../extension/model-router.ts";
import {
  planRoute,
  REGISTRY_PRICE_RELATIVE_TOLERANCE,
  type RoutePlanVerdict,
} from "../extension/route.ts";

function profile(
  id: string,
  price: readonly PriceRow[] = [
    { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: 2 },
  ],
  asOf = "2026-08-06",
): ModelProfile {
  return {
    id,
    aliases: [],
    tier: 1,
    tierSource: "fabricated",
    price,
    contextWindow: null,
    maxOutput: null,
    nonPreferred: null,
    routeFor: "tests",
    avoidFor: "none",
    hazards: [],
    capabilityMeasuredAt: ["medium"],
    evidenceGapAt: [],
    unknownRoutingCriticalFields: [],
    evidence: "fabricated",
    asOf,
  } as unknown as ModelProfile;
}

function profileSource(rows: readonly ModelProfile[]): RouterProfileSource {
  return {
    findProfile: (spec) => rows.find((row) => row.id === spec),
    ladderFor: () => ["medium"],
  };
}

interface MutableRegistry {
  models: Record<string, RouterRegistryModel | undefined>;
  throwFind: boolean;
  registry: RouterRegistry;
}

function mutableRegistry(models: Record<string, RouterRegistryModel | undefined>): MutableRegistry {
  const state: MutableRegistry = {
    models,
    throwFind: false,
    registry: undefined as unknown as RouterRegistry,
  };
  state.registry = {
    find(provider, id) {
      if (state.throwFind) throw new Error("registry unavailable");
      return state.models[`${provider}/${id}`];
    },
    hasConfiguredAuth: () => true,
  };
  return state;
}

function resolution(
  rows: readonly ModelProfile[],
  state: MutableRegistry,
  today = "2026-08-06",
): { resolution: ModelRouterResolution; warnings: string[]; warningClasses: RouterWarningClass[] } {
  const warnings: string[] = [];
  const warningClasses: RouterWarningClass[] = [];
  const resolved = resolveModelRouter(
    {
      registry: state.registry,
      models: rows.map((row) => row.id),
      profiles: profileSource(rows),
      today,
    },
    (warning, warningClass) => {
      warnings.push(warning);
      warningClasses.push(warningClass);
    },
  );
  assert.equal(resolved.on, true);
  return { resolution: resolved, warnings, warningClasses };
}

function plan(
  resolved: ModelRouterResolution,
  spec: string,
  day = "2026-08-06",
): RoutePlanVerdict {
  return planRoute({
    resolution: resolved,
    requestedModel: spec,
    currentDate: () => day,
  });
}

function divergenceWarnings(verdict: RoutePlanVerdict): readonly string[] {
  return verdict.warnings.filter((warning) => warning.includes("model-visible warning"));
}

const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const EXPERIMENTAL_LADDERS: Readonly<Record<string, readonly ThinkingLevel[]>> = {
  "openai-codex/gpt-5.3-codex-spark": ["off", "minimal", "low", "medium", "high", "xhigh"],
  "openai-codex/gpt-5.5": ["off", "minimal", "low", "medium", "high", "xhigh"],
  "openai-codex/gpt-6-astra": ["minimal", "low", "medium", "high", "xhigh", "max"],
};

test("every OpenAI profile has an equivalent Codex profile with independent lookup", () => {
  for (const original of MODEL_PROFILES.filter((p) => p.id.startsWith("openai/"))) {
    const id = original.id.replace("openai/", "openai-codex/");
    const copy = findProfile(id);
    assert.ok(copy, id);
    assert.equal(MODEL_PROFILES.filter((p) => p.id === id).length, 1);
    assert.deepEqual({ ...copy, id: original.id, aliases: original.aliases }, original);
    assert.deepEqual(ladderFor(copy), ladderFor(original));
    assert.deepEqual(copy.aliases, original.aliases.filter((alias) => alias.startsWith("openai/"))
      .map((alias) => alias.replace("openai/", "openai-codex/")));
    for (const alias of copy.aliases) assert.equal(findProfile(alias), copy);
    for (const alias of original.aliases) assert.equal(findProfile(alias), original);
    const resolved = resolveModelRouter({
      models: [original.id, id],
      registry: { find: () => ({ contextWindow: 1050000 }), hasConfiguredAuth: () => true },
    });
    assert.equal(resolved.candidates.length, 2);
    for (const level of ALL_THINKING_LEVELS) {
      assert.equal(checkEffort(resolved, id, level).verdict, checkEffort(resolved, original.id, level).verdict);
    }
  }
});

test("bridge profiles inherit native Anthropic data with independent provider identity and effort guards", () => {
  const bridge = ["claude-bridge/claude-sonnet-5", "claude-bridge/claude-opus-5"];
  for (const spec of bridge) {
    const nativeSpec = spec.replace("claude-bridge/", "anthropic/");
    const native = findProfile(nativeSpec);
    const copy = findProfile(spec);
    assert.ok(native, nativeSpec);
    assert.ok(copy, spec);
    assert.notEqual(copy, native);
    const aliases = native.aliases.filter((alias) => alias.startsWith("anthropic/"))
      .map((alias) => alias.replace("anthropic/", "claude-bridge/"));
    const expected = spec.endsWith("opus-5")
      ? { ...native, id: spec, aliases, evidenceGapAt: native.evidenceGapAt.filter((level) => level !== "off"), capabilityMeasuredAt: native.capabilityMeasuredAt.filter((level) => level !== "off") }
      : { ...native, id: spec, aliases };
    assert.deepEqual(copy, expected);
    assert.deepEqual(copy.aliases, aliases);
    for (const alias of copy.aliases) assert.equal(findProfile(alias), copy);
    assert.deepEqual(ladderFor(copy), spec.endsWith("opus-5") ? ["minimal", "low", "medium", "high", "xhigh", "max"] : ladderFor(native));
    assert.equal(copy.routeFor?.includes("synthetic"), false);
    assert.equal(copy.avoidFor?.includes("production"), false);
  }

  const resolved = resolveModelRouter({
    models: bridge,
    registry: { find: () => ({ contextWindow: 1000000 }), hasConfiguredAuth: () => true },
  });
  assert.equal(checkEffort(resolved, bridge[0] ?? "", "high").verdict, "ok");
  assert.equal(checkEffort(resolved, bridge[1] ?? "", "low").verdict, "ok");
  assert.equal(checkEffort(resolved, bridge[1] ?? "", "off").verdict, "off-ladder");
  assert.equal(planRoute({ resolution: resolved, requestedModel: bridge[0], requestedEffort: "high" }).kind, "proceed");
  assert.equal(planRoute({ resolution: resolved, requestedModel: bridge[1], requestedEffort: "off" }).kind, "reject");
  assert.equal(planRoute({ resolution: resolved, requestedModel: bridge[0], requestedEffort: "minimal", allowUnmeasuredEffort: false }).kind, "reject");
  const implicit = planRoute({ resolution: resolved, requestedModel: bridge[1] });
  assert.equal(implicit.kind, "proceed");
  if (implicit.kind === "proceed") assert.equal(implicit.effort, "low");
});

test("bridge alias transformation remains active when a native alias exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slate-bridge-alias-"));
  const sourcePath = new URL("../extension/model-profiles.ts", import.meta.url);
  const fixturePath = join(dir, "model-profiles.ts");
  try {
    const source = readFileSync(sourcePath, "utf8");
    const fixture = source.replace(
      'id: "anthropic/claude-sonnet-5",\n\t\t// The digest',
      'id: "anthropic/claude-sonnet-5",\n\t\taliases: ["anthropic/claude-sonnet-5-fixture"],\n\t\t// The digest',
    ).replace("\t\taliases: [],\n\t\t// First-party STANDARD tier", "\t\t// First-party STANDARD tier");
    assert.notEqual(fixture, source, "the native alias fixture must be inserted");
    writeFileSync(fixturePath, fixture);
    const transformed = await import(`${pathToFileURL(fixturePath).href}?fixture=${Date.now()}`);
    const bridge = transformed.findProfile("claude-bridge/claude-sonnet-5");
    assert.deepEqual(bridge?.aliases, ["claude-bridge/claude-sonnet-5-fixture"]);
    assert.equal(transformed.findProfile("claude-bridge/claude-sonnet-5-fixture"), bridge);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("experimental provider profiles remain distinct and pass real router and effort guards", () => {
  const experimental = Object.keys(EXPERIMENTAL_LADDERS);
  const native = [
    "openai/gpt-5.6-luna",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-sol",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-5",
  ];
  const models = Object.fromEntries([...native, ...experimental].map((spec) => [spec, { contextWindow: 272000 }]));
  const warnings: string[] = [];
  const resolved = resolveModelRouter({
    models: [...experimental].reverse().concat(native),
    registry: {
      find: (provider, id) => models[`${provider}/${id}`],
      hasConfiguredAuth: () => true,
    },
  }, (warning) => warnings.push(warning));

  assert.equal(resolved.on, true);
  assert.equal(resolved.candidates.length, native.length + experimental.length);
  assert.equal(resolved.cheapest, "openai/gpt-5.6-luna", "experimental profiles must not change the preferred default");
  for (const spec of experimental) {
    const p = findProfile(spec);
    assert.ok(p, spec);
    assert.equal(p.id, spec);
    assert.equal(p.tier, null);
    assert.equal(p.tierUnsourced, true);
    assert.equal(p.nonPreferred?.startsWith("NON-PREFERRED"), true);
    assert.match(p.nonPreferred ?? "", /implicit base/);
    assert.equal(p.routeFor, "synthetic non-sensitive experiments; explicit routing preferred");
    assert.equal(p.avoidFor, "avoid review, gate, sensitive, or production work; advice is not enforced");
    assert.deepEqual(p.price, []);
    assert.deepEqual(p.capabilityMeasuredAt, []);
    assert.deepEqual(ladderFor(p), EXPERIMENTAL_LADDERS[spec]);
    assert.deepEqual(p.evidenceGapAt, EXPERIMENTAL_LADDERS[spec]);
    assert.equal(resolved.candidates.some((candidate) => candidate.spec === spec), true);
    for (const level of EXPERIMENTAL_LADDERS[spec] ?? []) {
      assert.equal(checkEffort(resolved, spec, level).verdict, "evidence-gap", `${spec} @${level}`);
    }
  }
  assert.notEqual(findProfile("openai/gpt-5.6-sol"), findProfile("openai-codex/gpt-5.6-sol"));
  assert.notEqual(findProfile("anthropic/claude-sonnet-5"), findProfile("claude-bridge/claude-sonnet-5"));
  assert.notEqual(findProfile(experimental[0] ?? "")?.evidenceGapAt, findProfile(experimental[1] ?? "")?.evidenceGapAt);
  assert.equal(warnings.some((warning) => warning.includes("name the same profiled model")), false);

  for (const [spec, ladder] of Object.entries(EXPERIMENTAL_LADDERS)) {
    const supported = ladder[0];
    assert.ok(supported, spec);
    const allowed = planRoute({ resolution: resolved, requestedModel: spec, requestedEffort: supported });
    assert.equal(allowed.kind, "proceed", `${spec} supports ${supported}`);
    assert.equal(allowed.effortUnmeasured, true, `${spec} marks ${supported} unmeasured`);
    const refused = planRoute({ resolution: resolved, requestedModel: spec, requestedEffort: supported, allowUnmeasuredEffort: false });
    assert.equal(refused.kind, "reject", `${spec} refuses unmeasured ${supported} in strict mode`);
    for (const unsupported of ALL_THINKING_LEVELS.filter((level) => !ladder.includes(level))) {
      const offLadder = planRoute({ resolution: resolved, requestedModel: spec, requestedEffort: unsupported });
      assert.equal(offLadder.kind, "reject", `${spec} refuses unsupported ${unsupported}`);
    }
  }

  const nativeTerraIndex = resolved.candidates.findIndex((candidate) => candidate.spec === "openai/gpt-5.6-terra");
  const firstExperimentalIndex = resolved.candidates.findIndex((candidate) => candidate.spec === experimental[0]);
  assert.ok(nativeTerraIndex >= 0 && firstExperimentalIndex >= 0 && nativeTerraIndex < firstExperimentalIndex,
    "an unsourced numeric cost class must sort before a wholly unknown tier in the same nonpreferred class");

  const absent = "openai-codex/gpt-5.5";
  const unauthorized = "openai-codex/gpt-6-astra";
  const unauthorizedModel = models[unauthorized];
  delete models[absent];
  const droppedWarnings: string[] = [];
  const dropped = resolveModelRouter({
    models: experimental,
    registry: {
      find: (provider, id) => models[`${provider}/${id}`],
      hasConfiguredAuth: (model) => model !== unauthorizedModel,
    },
  }, (warning) => droppedWarnings.push(warning));
  assert.equal(dropped.candidates.some((candidate) => candidate.spec === absent), false);
  assert.equal(dropped.candidates.some((candidate) => candidate.spec === unauthorized), false);
  assert.equal(droppedWarnings.some((warning) => warning.includes("not in pi's model registry")), true);
  assert.equal(droppedWarnings.some((warning) => warning.includes("no usable credentials configured")), true);
  assert.equal(MODEL_PROFILES.filter((p) => experimental.includes(p.id)).length, 3);
});

test("registry costs survive absent, malformed, non-finite, and throwing fields", () => {
  const throwingCost = {
    get input(): number {
      throw new Error("hostile input getter");
    },
    output: 7,
    cacheRead: 0,
    cacheWrite: 3,
  };
  const state = mutableRegistry({
    "p/no-cost": { contextWindow: 10 },
    "p/no-input": { contextWindow: 10, cost: { output: 2 } },
    "p/text": {
      contextWindow: 10,
      cost: { input: "1" } as unknown as RouterRegistryModel["cost"],
    },
    "p/infinite": { contextWindow: 10, cost: { input: Number.POSITIVE_INFINITY } },
    "p/throwing": { contextWindow: 10, cost: throwingCost },
  });
  const rows = Object.keys(state.models).map((spec) => profile(spec));
  const { resolution: resolved } = resolution(rows, state);
  const costs = Object.fromEntries(
    resolved.candidates.map((candidate) => [candidate.spec, candidate.registryCost]),
  );

  assert.deepEqual(costs["p/no-cost"], {
    input: undefined,
    output: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  });
  assert.equal(costs["p/no-input"]?.input, undefined);
  assert.equal(costs["p/no-input"]?.output, 2);
  assert.equal(costs["p/text"]?.input, undefined);
  assert.equal(costs["p/infinite"]?.input, undefined);
  assert.deepEqual(costs["p/throwing"], {
    input: undefined,
    output: 7,
    cacheRead: 0,
    cacheWrite: 3,
  });

  assert.equal(resolved.registryCostFor?.("not-a-spec"), undefined);
  assert.equal(resolved.registryCostFor?.("p/missing"), undefined);
  state.throwFind = true;
  assert.equal(resolved.registryCostFor?.("p/no-cost"), undefined);
});

test("price validity accepts zero and positive finite prices only", () => {
  for (const value of [undefined, null, "0", Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    assert.equal(isValidPrice(value), false, `expected ${String(value)} to be invalid`);
  }
  assert.equal(isValidPrice(0), true);
  assert.equal(isValidPrice(0.25), true);
});

test("invalid and absent prices sort last while zero remains cheapest", () => {
  const rows = [
    profile("p/negative", [{ from: null, until: null, inUsdPerMTok: -1, outUsdPerMTok: 2 }]),
    profile("p/infinite", [{ from: null, until: null, inUsdPerMTok: Number.POSITIVE_INFINITY, outUsdPerMTok: 2 }]),
    profile("p/absent", [{ from: null, until: null, outUsdPerMTok: 2 } as PriceRow]),
    profile("p/positive", [{ from: null, until: null, inUsdPerMTok: 2, outUsdPerMTok: 2 }]),
    profile("p/zero", [{ from: null, until: null, inUsdPerMTok: 0, outUsdPerMTok: 2 }]),
  ];
  const state = mutableRegistry(Object.fromEntries(rows.map((row) => [row.id, { contextWindow: 10 }])));
  const { resolution: resolved, warnings, warningClasses } = resolution(rows, state);
  const candidates = Object.fromEntries(resolved.candidates.map((candidate) => [candidate.spec, candidate]));

  assert.deepEqual(resolved.candidates.map((candidate) => candidate.spec), [
    "p/zero",
    "p/positive",
    "p/absent",
    "p/infinite",
    "p/negative",
  ]);
  assert.equal(resolved.cheapest, "p/zero");
  assert.equal(candidates["p/zero"]?.inUsdPerMTok, 0);
  assert.equal(candidates["p/absent"]?.inUsdPerMTok, undefined);
  assert.notEqual(candidates["p/zero"]?.inUsdPerMTok, candidates["p/absent"]?.inUsdPerMTok);
  const invalidIndexes = warnings.flatMap((warning, index) => warning.includes("invalid input price data") ? [index] : []);
  assert.equal(invalidIndexes.length, 2);
  assert.equal(invalidIndexes.every((index) => warningClasses[index] === "model-data-note"), true);
  assert.equal(warnings.some((warning) => warning.includes("p/absent has invalid")), false);
});

test("fresh material registry divergence emits the exact advisory without changing the route", () => {
  const spec = "p/priced";
  const model = {
    contextWindow: 10,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  const state = mutableRegistry({ [spec]: model });
  const { resolution: resolved, warnings: userWarnings, warningClasses } = resolution([profile(spec)], state);
  const equal = plan(resolved, spec);
  model.cost.input = 2.3456789;
  const diverged = plan(resolved, spec);
  const expectedModelVisible =
    "slate: model router: live registry pricing for p/priced differs materially from the shipped profile row for 2026-08-06. " +
    "Registry input is higher by twofold to tenfold. Candidate ordering still uses shipped prices. Dispatching anyway. " +
    "Exact rates are omitted from this model-visible warning.";
  const expectedUserOnly =
    "slate: model router: exact live registry pricing for p/priced differs from the shipped profile row for 2026-08-06. " +
    "Profile asOf 2026-08-06. Input: shipped $1 and registry $2.3456789 per million tokens. " +
    "Candidate ordering still uses shipped prices.";

  assert.equal(equal.kind, "proceed");
  assert.equal(diverged.kind, "proceed");
  assert.equal(equal.model, spec);
  assert.equal(diverged.model, spec);
  assert.deepEqual(divergenceWarnings(equal), []);
  assert.deepEqual(diverged.warnings, [expectedModelVisible]);
  const repeated = plan(resolved, spec);
  assert.deepEqual(repeated.warnings, [expectedModelVisible]);
  const exactIndexes = userWarnings.flatMap((warning, index) => warning === expectedUserOnly ? [index] : []);
  assert.equal(exactIndexes.length, 1);
  assert.equal(exactIndexes.every((index) => warningClasses[index] === "model-data-note"), true);
  model.cost.input = 20;
  const refreshed = plan(resolved, spec);
  assert.equal(divergenceWarnings(refreshed).length, 1);
  assert.equal(userWarnings.some((warning) => warning.includes("registry $20 per million tokens")), true);
  assert.equal(userWarnings.filter((warning) => warning.includes("exact live registry pricing")).length, 2);
  assert.equal(expectedModelVisible.includes("2.3456789"), false);
  assert.equal(JSON.stringify(diverged).includes("2.3456789"), false);
});

test("divergence warnings apply router field and whole-message hardening", () => {
  const spec = `p/${"m".repeat(260)}`;
  const hostileAsOf = `[private] ${"x".repeat(240)}\u202e\n`;
  const model = { contextWindow: 10, cost: { input: 3, output: 2 } };
  const state = mutableRegistry({ [spec]: model });
  const p = profile(spec, undefined, hostileAsOf);
  const { resolution: resolved, warnings } = resolution([p], state);
  const verdict = plan(resolved, spec);
  const exact = warnings.find((warning) => warning.includes("exact live registry pricing"));
  const visible = divergenceWarnings(verdict)[0];

  assert.ok(exact);
  assert.ok(visible);
  for (const warning of [exact, visible]) {
    assert.ok(warning.length <= 800);
    assert.doesNotMatch(warning, /[\u0000-\u001f\u007f\u0080-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
    assert.equal(warning.includes("m".repeat(200)), false);
  }
  assert.doesNotMatch(exact, /\[private\]/);
  assert.equal(exact.includes("x".repeat(200)), false);
});

test("input and output divergence honour both sides of the relative tolerance", () => {
  const spec = "p/tolerance";
  const model = { contextWindow: 10, cost: { input: 1, output: 2 } };
  const state = mutableRegistry({ [spec]: model });
  const { resolution: resolved } = resolution([profile(spec)], state);

  model.cost.input = 1 + REGISTRY_PRICE_RELATIVE_TOLERANCE * 0.5;
  model.cost.output = 2 + 2 * REGISTRY_PRICE_RELATIVE_TOLERANCE * 0.5;
  assert.deepEqual(divergenceWarnings(plan(resolved, spec)), []);

  model.cost.input = 1 + REGISTRY_PRICE_RELATIVE_TOLERANCE * 2;
  model.cost.output = 2;
  const inputWarning = divergenceWarnings(plan(resolved, spec));
  assert.equal(inputWarning.length, 1);
  assert.match(inputWarning[0] ?? "", /Registry input is higher by less than twofold/);
  assert.doesNotMatch(inputWarning[0] ?? "", /Registry output/);

  model.cost.input = 1;
  model.cost.output = 2 + 2 * REGISTRY_PRICE_RELATIVE_TOLERANCE * 2;
  const outputWarning = divergenceWarnings(plan(resolved, spec));
  assert.equal(outputWarning.length, 1);
  assert.match(outputWarning[0] ?? "", /Registry output is higher by less than twofold/);
  assert.doesNotMatch(outputWarning[0] ?? "", /Registry input/);
});

test("absent or invalid prices on either source stay silent and advisory", () => {
  const cases: Array<{
    name: string;
    row: PriceRow;
    cost: Record<string, unknown>;
  }> = [
    { name: "registry input absent", row: { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: 2 }, cost: { output: 2 } },
    { name: "registry input invalid", row: { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: 2 }, cost: { input: -1, output: 2 } },
    { name: "shipped input absent", row: { from: null, until: null, outUsdPerMTok: 2 } as PriceRow, cost: { input: 1, output: 2 } },
    { name: "shipped input invalid", row: { from: null, until: null, inUsdPerMTok: Number.NaN, outUsdPerMTok: 2 }, cost: { input: 1, output: 2 } },
    { name: "registry output absent", row: { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: 2 }, cost: { input: 1 } },
    { name: "registry output invalid", row: { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: 2 }, cost: { input: 1, output: Number.POSITIVE_INFINITY } },
    { name: "shipped output absent", row: { from: null, until: null, inUsdPerMTok: 1 } as PriceRow, cost: { input: 1, output: 2 } },
    { name: "shipped output invalid", row: { from: null, until: null, inUsdPerMTok: 1, outUsdPerMTok: -2 }, cost: { input: 1, output: 2 } },
  ];

  for (const item of cases) {
    const spec = `p/${item.name.replaceAll(" ", "-")}`;
    const state = mutableRegistry({
      [spec]: {
        contextWindow: 10,
        cost: item.cost as RouterRegistryModel["cost"],
      },
    });
    const { resolution: resolved } = resolution([profile(spec, [item.row])], state);
    const verdict = plan(resolved, spec);
    assert.equal(verdict.kind, "proceed", item.name);
    assert.deepEqual(divergenceWarnings(verdict), [], item.name);
  }
});

test("the dispatch date selects the covering shipped schedule", () => {
  const spec = "p/dated";
  const rows: PriceRow[] = [
    { from: null, until: "2026-07-29", inUsdPerMTok: 1, outUsdPerMTok: 2 },
    { from: "2026-07-30", until: null, inUsdPerMTok: 0.2, outUsdPerMTok: 1.2 },
  ];
  const model = { contextWindow: 10, cost: { input: 1, output: 2 } };
  const state = mutableRegistry({ [spec]: model });
  const p = profile(spec, rows, "2026-07-30");
  const { resolution: resolved } = resolution([p], state, "2026-07-29");

  assert.equal(coveringPriceRow(p, "not-a-date"), undefined);
  assert.equal(coveringPriceRow(profile("p/empty", []), "2026-07-29"), undefined);
  assert.equal(coveringPriceRow(p, "2026-07-29")?.inUsdPerMTok, 1);
  assert.equal(coveringPriceRow(p, "2026-07-30")?.inUsdPerMTok, 0.2);
  assert.deepEqual(divergenceWarnings(plan(resolved, spec, "2026-07-29")), []);
  const boundary = divergenceWarnings(plan(resolved, spec, "2026-07-30"));
  assert.equal(boundary.length, 1);
  assert.match(boundary[0] ?? "", /Registry input is higher by twofold to tenfold/);
  assert.match(boundary[0] ?? "", /Registry output is higher by less than twofold/);

  model.cost = { input: 0.2, output: 1.2 };
  assert.equal(divergenceWarnings(plan(resolved, spec, "2026-07-29")).length, 1);
  assert.deepEqual(divergenceWarnings(plan(resolved, spec, "2026-07-30")), []);
});

test("failover price divergence remains advisory for listed targets", () => {
  const spec = "p/failover-target";
  const model = { contextWindow: 10, cost: { input: 3, output: 2 } };
  const state = mutableRegistry({ [spec]: model });
  const { resolution: resolved } = resolution([profile(spec)], state);
  const verdict = planRoute({
    resolution: resolved,
    requestedModel: spec,
    failoverSwitch: true,
    failoverFrom: "p/failed",
    currentDate: () => "2026-08-06",
  });

  assert.equal(verdict.kind, "proceed");
  assert.equal(verdict.model, spec);
  assert.equal(divergenceWarnings(verdict).length, 1);

  const unlisted = planRoute({
    resolution: resolved,
    requestedModel: "p/unlisted-fallback",
    failoverSwitch: true,
    failoverFrom: "p/failed",
    currentDate: () => "2026-08-06",
  });
  assert.equal(unlisted.kind, "proceed");
  assert.deepEqual(divergenceWarnings(unlisted), []);
});

test("divergence evidence failures stay silent and never block dispatch", () => {
  const spec = "p/fail-soft";
  const model: RouterRegistryModel = { contextWindow: 10, cost: { input: 1, output: 2 } };
  const state = mutableRegistry({ [spec]: model });
  const p = profile(spec);
  const { resolution: resolved } = resolution([p], state);

  const assertSilentProceed = (candidate: ModelRouterResolution, currentDate?: () => string) => {
    const verdict = planRoute({ resolution: candidate, requestedModel: spec, currentDate });
    assert.equal(verdict.kind, "proceed");
    assert.deepEqual(divergenceWarnings(verdict), []);
  };

  state.models[spec] = undefined;
  assertSilentProceed(resolved, () => "2026-08-06");
  state.models[spec] = model;
  state.throwFind = true;
  assertSilentProceed(resolved, () => "2026-08-06");
  state.throwFind = false;
  assertSilentProceed(resolved, () => {
    throw new Error("clock unavailable");
  });
  assertSilentProceed(resolved, () => "invalid-date");

  const noRegistryReader = { ...resolved, registryCostFor: undefined };
  assertSilentProceed(noRegistryReader, () => "2026-08-06");
  const noDateReader = { ...resolved, currentDate: undefined };
  assertSilentProceed(noDateReader);

  model.cost = { input: 3, output: 2 };
  const throwingWarningPath = {
    ...resolved,
    warnOnce: () => {
      throw new Error("UI unavailable");
    },
  };
  const withThrowingWarningPath = planRoute({
    resolution: throwingWarningPath,
    requestedModel: spec,
    currentDate: () => "2026-08-06",
  });
  assert.equal(withThrowingWarningPath.kind, "proceed");
  assert.equal(divergenceWarnings(withThrowingWarningPath).length, 1);
  model.cost = { input: 1, output: 2 };

  Object.defineProperty(p, "price", {
    configurable: true,
    get() {
      throw new Error("price unavailable");
    },
  });
  assertSilentProceed(resolved, () => "2026-08-06");
});
