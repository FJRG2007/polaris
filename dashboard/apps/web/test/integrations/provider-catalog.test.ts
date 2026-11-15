/**
 * The provider catalogue as data: seeding is idempotent, an index download is
 * validated before anything is stored, an operator's own provider is checked
 * against everything already claimed, and the picker is paged in the database.
 * The store is an in-memory stand-in for the one table these functions touch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = Record<string, unknown> & { slug: string };
const table = new Map<string, Stored>();
const writes: string[] = [];

function matches(row: Stored, where: any): boolean {
    if (!where) return true;
    if (where.AND) return where.AND.every((part: any) => matches(row, part));
    return Object.entries(where).every(([key, cond]: [string, any]) => {
        const value = row[key];
        if (cond && typeof cond === "object") {
            if ("in" in cond) return cond.in.includes(value);
            if ("not" in cond) return cond.not === null ? value != null : value !== cond.not;
            if ("contains" in cond) return String(value).includes(cond.contains);
        }
        return value === cond;
    });
}

const modelProviderEntry = {
    findMany: async ({ where, skip = 0, take = Infinity, orderBy }: any) => {
        let rows = [...table.values()].filter((row) => matches(row, where));
        if (orderBy) {
            rows = rows.sort(
                (a: any, b: any) => a.rank - b.rank || String(a.name).localeCompare(String(b.name))
            );
        }
        return rows.slice(skip, skip + take);
    },
    upsert: ({ where, create, update }: any) => {
        writes.push(where.slug);
        table.set(where.slug, { ...(table.get(where.slug) ?? create), ...update });
        return Promise.resolve();
    },
    create: async ({ data }: any) => table.set(data.slug, data),
    deleteMany: async ({ where }: any) => {
        let count = 0;
        for (const row of [...table.values()]) {
            if (matches(row, where)) {
                table.delete(row.slug);
                count += 1;
            }
        }
        return { count };
    }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        modelProviderEntry,
        modelProviderIndexState: { upsert: async () => undefined, findUnique: async () => null },
        $transaction: async (ops: unknown[]) => Promise.all(ops)
    }
}));

const catalog = await import("../../src/lib/integrations/provider-catalog");
const snapshot = await import("../../src/lib/integrations/provider-catalog-snapshot");
const { MODEL_PROVIDER_SEEDS } = await import("../../src/lib/integrations/model-providers");
const { providerForModel, modelProviders } = await import("../../src/lib/agents/agent-providers");
const { providerIsCheckable } = await import("../../src/lib/agents/provider-key-check");
const { opencodeModelConfig } = await import("../../src/lib/agents/opencode-model");

beforeEach(() => {
    table.clear();
    writes.length = 0;
});

describe("seeding the catalogue", () => {
    it("writes every seed once, and nothing on the next boot", async () => {
        const first = await catalog.seedProviderCatalog();
        expect(first.written).toBeGreaterThan(MODEL_PROVIDER_SEEDS.length);
        writes.length = 0;
        const second = await catalog.seedProviderCatalog();
        expect(second.written).toBe(0);
        expect(writes).toEqual([]);
    });

    it("reads the store back into what the runs use", async () => {
        await catalog.seedProviderCatalog();
        expect(await catalog.loadProviderCatalog()).toBe(MODEL_PROVIDER_SEEDS.length);
        expect(providerForModel("coarena/claude-sonnet-5-5")?.envVar).toBe("COARENA_API_KEY");
    });
});

describe("the public index", () => {
    const taken = { slugs: new Set(["mistral"]), envVars: new Set(["MISTRAL_API_KEY"]) };
    const model = { id: "m-1", name: "M 1", tool_call: true, limit: { context: 1000 }, release_date: "2026-01-01" };

    it("keeps a single-credential provider with a model an agent can run", () => {
        const rows = catalog.parseProviderIndex(
            {
                newco: {
                    id: "newco",
                    name: "NewCo",
                    env: ["NEWCO_API_KEY"],
                    npm: "@ai-sdk/openai-compatible",
                    api: "https://api.newco.example/v1/",
                    doc: "https://newco.example/docs",
                    models: { "m-0": { ...model, id: "m-0", release_date: "2025-01-01" }, "m-1": model }
                }
            },
            taken
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            slug: "newco",
            kind: "listed",
            envVar: "NEWCO_API_KEY",
            baseUrl: "https://api.newco.example/v1",
            wire: "openai",
            defaultModel: { slug: "newco/m-1" }
        });
        expect(rows[0]!.free).toBeUndefined();
    });

    it("drops what it must not offer", () => {
        const rows = catalog.parseProviderIndex(
            {
                cloud: { id: "cloud", name: "Cloud", env: ["A_KEY", "B_SECRET"], models: { m: model } },
                "github-copilot": { id: "github-copilot", name: "Copilot", env: ["GH_TOKEN"], models: { m: model } },
                mistral: { id: "mistral", name: "Mistral", env: ["OTHER_KEY"], models: { m: model } },
                clash: { id: "clash", name: "Clash", env: ["MISTRAL_API_KEY"], models: { m: model } },
                notools: { id: "notools", name: "No tools", env: ["NOTOOLS_KEY"], models: { m: { id: "m" } } },
                plain: { id: "plain", name: "Plain", env: ["PLAIN_KEY"], api: "http://insecure", models: { m: model } },
                bad: "not an object"
            },
            taken
        );
        expect(rows.map((row) => row.slug)).toEqual([]);
    });

    it("stores nothing from a download that carried nothing usable", async () => {
        const result = await catalog.storeProviderIndex({ junk: { id: 1 } }, null);
        expect(result.ok).toBe(false);
        expect(table.size).toBe(0);
    });

    it("never removes an index row the next download leaves out", async () => {
        const entry = (id: string) => ({ id, name: id, env: [`${id.toUpperCase()}_KEY`], models: { m: model } });
        await catalog.storeProviderIndex({ alpha: entry("alpha"), beta: entry("beta") }, "etag-1");
        await catalog.storeProviderIndex({ alpha: entry("alpha") }, "etag-2");
        expect([...table.keys()].sort()).toEqual(["alpha", "beta"]);
    });
});

describe("an operator's own provider", () => {
    const input = {
        name: "Acme AI",
        baseUrl: "https://llm.acme.example/v1",
        wire: "openai" as const,
        envVar: "acme_api_key",
        defaultModel: "acme-large"
    };

    it("is stored outside the index with its endpoint", async () => {
        const result = await catalog.addCustomProvider(input, "00000000-0000-7000-8000-000000000000");
        expect(result).toEqual({ ok: true, slug: "acme-ai" });
        expect(table.get("acme-ai")).toMatchObject({
            source: "custom",
            envVar: "ACME_API_KEY",
            outsideIndex: true,
            defaultModelSlug: "acme-ai/acme-large"
        });
        expect(modelProviders().some((provider) => provider.slug === "acme-ai")).toBe(true);
        expect(await catalog.removeCustomProvider("acme-ai")).toBe(true);
    });

    it("refuses a slug or a variable somebody already has, and private hosts", async () => {
        expect(await catalog.addCustomProvider({ ...input, name: "Mistral" }, "x")).toEqual({ ok: false, reason: "taken" });
        expect(await catalog.addCustomProvider({ ...input, envVar: "OPENAI_API_KEY" }, "x")).toEqual({ ok: false, reason: "envTaken" });
        for (const baseUrl of ["http://llm.acme.example", "https://localhost/v1", "https://10.0.0.2/v1", "https://box.local/v1"]) {
            expect(await catalog.addCustomProvider({ ...input, baseUrl }, "x")).toEqual({ ok: false, reason: "invalid" });
        }
        expect(await catalog.addCustomProvider({ ...input, envVar: "POLARIS_SECRET" }, "x")).toEqual({ ok: false, reason: "invalid" });
    });

    it("is never removed when it came from code", async () => {
        await catalog.seedProviderCatalog();
        expect(await catalog.removeCustomProvider("coarena")).toBe(false);
        expect(table.has("coarena")).toBe(true);
    });
});

describe("the picker", () => {
    it("pages through the store, searched and filtered there", async () => {
        await catalog.seedProviderCatalog();
        const first = await catalog.searchProviderCatalog({ take: 10 });
        expect(first.hits).toHaveLength(10);
        expect(first.next).toBe(10);
        // The hand-written providers come first.
        expect(first.hits[0]!.source).toBe("builtin");
        const second = await catalog.searchProviderCatalog({ take: 10, offset: first.next! });
        expect(second.hits.map((hit) => hit.slug)).not.toContain(first.hits[0]!.slug);

        const found = await catalog.searchProviderCatalog({ query: "Coarena" });
        expect(found.hits.map((hit) => hit.slug)).toEqual(["coarena"]);
        expect(found.next).toBeNull();

        const free = await catalog.searchProviderCatalog({ free: "free", take: 50 });
        expect(free.hits.length).toBeGreaterThan(0);
        expect(free.hits.every((hit) => hit.freeTier?.kind === "free")).toBe(true);
    });

    it("refuses a page size past its bound", () => {
        expect(() => catalog.providerSearchSchema.parse({ take: 5000 })).toThrow();
    });
});

describe("Coarena", () => {
    const coarena = MODEL_PROVIDER_SEEDS.find((seed) => seed.slug === "coarena")!;

    it("is reached by its endpoint, since the public index does not carry it", () => {
        expect(coarena).toMatchObject({
            outsideIndex: true,
            baseUrl: "https://coarena.ai/api/v1",
            wire: "openai",
            anthropicBaseUrl: "https://coarena.ai/api",
            envVar: "COARENA_API_KEY",
            free: { kind: "free" }
        });
        expect(snapshot.catalogEndpoint("coarena")).toEqual({ api: "openai", baseUrl: "https://coarena.ai/api/v1" });
    });

    it("checks a key at /limits, never at the public model list", () => {
        expect(coarena.probe).toBe("https://coarena.ai/api/v1/limits");
        expect(providerIsCheckable("coarena")).toBe(true);
    });

    it("hands OpenCode its endpoint rather than a name it cannot resolve", () => {
        const config = opencodeModelConfig({
            provider: "coarena",
            model: "claude-sonnet-5-5",
            secret: "k",
            baseUrl: null,
            gatewayModel: null
        }) as any;
        expect(config.model).toBe("coarena/claude-sonnet-5-5");
        expect(config.provider.coarena).toMatchObject({
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://coarena.ai/api/v1" }
        });
    });
});
