/**
 * The models a provider outside the index serves, read from its own endpoint:
 * parsed strictly, bounded, asked through the guarded fetch, and never allowed
 * to wipe what was stored when the endpoint does not answer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    fetched: [] as string[],
    keys: [] as Array<string | null>,
    bodies: new Map<string, { status: number; body: string }>(),
    deleted: [] as string[],
    created: [] as Array<{ slug: string }>
}));

vi.mock("undici", () => ({
    Agent: class {},
    fetch: async (input: URL | string, init?: { headers?: HeadersInit }) => {
        const address = String(input);
        state.fetched.push(address);
        const key = new Headers(init?.headers).get("authorization");
        state.keys.push(key);
        // An endpoint that lists only to a key answers 401 to everybody else.
        const canned = state.bodies.get(key ? `${address} ${key}` : address);
        if (!canned) throw new Error("nothing there");
        return new Response(canned.body, { status: canned.status });
    }
}));

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => [
        { address: hostname === "inside.example" ? "192.168.1.10" : "93.184.216.34", family: 4 }
    ]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentModel: {
            deleteMany: vi.fn(async ({ where }: { where: { provider: string } }) => {
                state.deleted.push(where.provider);
                return { count: 0 };
            }),
            createMany: vi.fn(async ({ data }: { data: Array<{ slug: string }> }) => {
                state.created.push(...data);
                return { count: data.length };
            })
        },
        $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations)
    }
}));

const models = await import("@/lib/agents/endpoint-models");
const snapshot = await import("@/lib/integrations/provider-catalog-snapshot");

function row(slug: string, host: string): snapshot.CatalogProvider {
    return {
        slug,
        name: slug,
        kind: "listed",
        envVar: `${slug.toUpperCase()}_API_KEY`,
        summary: "Test endpoint.",
        docsUrl: `https://${host}/docs`,
        defaultModel: { label: "m", slug: `${slug}/m` },
        outsideIndex: true,
        baseUrl: `https://${host}/v1/`,
        wire: "openai",
        source: "custom"
    };
}

beforeEach(() => {
    state.fetched.length = 0;
    state.keys.length = 0;
    state.bodies.clear();
    state.deleted.length = 0;
    state.created.length = 0;
    snapshot.replaceCatalogProviders([]);
});

describe("an endpoint's model list", () => {
    it("keeps usable ids once each, skipping anything else", () => {
        const rows = models.parseEndpointModels("mine", {
            data: [{ id: "alpha", name: "Alpha" }, { id: "alpha" }, { id: "has space" }, { id: 7 }, "x", { id: "beta" }]
        });
        expect(rows).toEqual([
            { slug: "mine/alpha", provider: "mine", modelId: "alpha", name: "Alpha" },
            { slug: "mine/beta", provider: "mine", modelId: "beta", name: "beta" }
        ]);
    });

    it("refuses an answer that is not the list shape", () => {
        expect(models.parseEndpointModels("mine", { models: [{ id: "a" }] })).toEqual([]);
        expect(models.parseEndpointModels("mine", null)).toEqual([]);
    });

    it("keeps at most the ceiling from one endpoint", () => {
        const data = Array.from({ length: 500 }, (_, i) => ({ id: `m${i}` }));
        expect(models.parseEndpointModels("mine", { data })).toHaveLength(models.MAX_MODELS);
    });
});

describe("refreshing the endpoints' models", () => {
    it("stores what a public endpoint lists, under the provider's slug", async () => {
        snapshot.replaceCatalogProviders([row("mine", "public.example")]);
        state.bodies.set("https://public.example/v1/models", {
            status: 200,
            body: JSON.stringify({ data: [{ id: "alpha" }, { id: "beta" }] })
        });
        expect(await models.refreshEndpointModels()).toBe(2);
        expect(state.deleted).toEqual(["mine"]);
        expect(state.created.map((entry) => entry.slug)).toEqual(["mine/alpha", "mine/beta"]);
    });

    it("never asks an endpoint whose name resolves inside the network", async () => {
        snapshot.replaceCatalogProviders([row("lan", "inside.example")]);
        expect(await models.refreshEndpointModels(["lan"])).toBe(0);
        expect(state.fetched).toEqual([]);
        expect(state.deleted).toEqual([]);
    });

    it("keeps what was stored when an endpoint refuses or answers nothing usable", async () => {
        snapshot.replaceCatalogProviders([row("shut", "shut.example"), row("odd", "odd.example")]);
        state.bodies.set("https://shut.example/v1/models", { status: 401, body: "{}" });
        state.bodies.set("https://odd.example/v1/models", { status: 200, body: "<html>" });
        expect(await models.refreshEndpointModels()).toBe(0);
        expect(state.deleted).toEqual([]);
    });

    it("refuses an answer past the byte ceiling", async () => {
        snapshot.replaceCatalogProviders([row("huge", "huge.example")]);
        const data = Array.from({ length: 60_000 }, (_, i) => ({ id: `model-${i}-${"x".repeat(10)}` }));
        state.bodies.set("https://huge.example/v1/models", { status: 200, body: JSON.stringify({ data }) });
        expect(await models.refreshEndpointModels()).toBe(0);
    });

    it("asks no more than the provider ceiling", () => {
        snapshot.replaceCatalogProviders(
            Array.from({ length: 80 }, (_, i) => row(`p${i}`, `p${i}.example`))
        );
        // Coarena's seed row is kept beside them, and still counts toward the ceiling.
        expect(models.endpointProviders()).toHaveLength(models.MAX_PROVIDERS);
    });
});

describe("an endpoint that lists its models only to a key", () => {
    const list = "https://api.numes.ai/api/v1/models";

    it("is read with the key just saved for it, and stored", async () => {
        state.bodies.set(list, { status: 401, body: "{}" });
        state.bodies.set(`${list} Bearer sk-numes`, {
            status: 200,
            body: JSON.stringify({ data: [{ id: "openai/gpt-6-luna" }, { id: "qwen/qwen-4" }] })
        });
        expect(await models.refreshEndpointModelsWithKey("numes", " sk-numes ")).toBe(2);
        expect(state.created.map((entry) => entry.slug)).toEqual([
            "numes/openai/gpt-6-luna",
            "numes/qwen/qwen-4"
        ]);
    });

    it("keeps that list when the keyless daily refresh is refused", async () => {
        state.bodies.set(list, { status: 401, body: "{}" });
        expect(await models.refreshEndpointModels(["numes"])).toBe(0);
        expect(state.keys).toEqual([null]);
        expect(state.deleted).toEqual([]);
    });

    it("sends no key to a provider in the public index", async () => {
        expect(await models.refreshEndpointModelsWithKey("openai", "sk-x")).toBe(0);
        expect(state.fetched).toEqual([]);
    });
});
