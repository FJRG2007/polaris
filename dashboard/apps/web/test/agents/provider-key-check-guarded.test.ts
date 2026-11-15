/**
 * A key check sent to an endpoint the catalogue store holds - an operator's own
 * provider, or one the public index added - goes through the guarded fetch, so
 * a name that resolves inside the network is refused when the check runs, not
 * only when the row was saved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const network = vi.hoisted(() => ({ fetched: [] as string[] }));

vi.mock("undici", () => ({
    Agent: class {},
    fetch: async (input: URL | string) => {
        network.fetched.push(String(input));
        return new Response("{}", { status: 200 });
    }
}));

vi.mock("node:dns/promises", () => ({
    lookup: async (hostname: string) => [
        { address: hostname === "rebound.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }
    ]
}));

const { checkProviderKey } = await import("@/lib/agents/provider-key-check");
const snapshot = await import("@/lib/integrations/provider-catalog-snapshot");

function customRow(slug: string, host: string): snapshot.CatalogProvider {
    return {
        slug,
        name: slug,
        kind: "listed",
        envVar: `${slug.toUpperCase()}_API_KEY`,
        summary: "Test endpoint.",
        docsUrl: `https://${host}/docs`,
        probe: `https://${host}/v1/models`,
        defaultModel: { label: "m", slug: `${slug}/m` },
        outsideIndex: true,
        baseUrl: `https://${host}/v1`,
        wire: "openai",
        source: "custom"
    };
}

beforeEach(() => {
    network.fetched.length = 0;
    snapshot.replaceCatalogProviders([
        customRow("rebound", "rebound.example"),
        customRow("honest", "honest.example")
    ]);
});

afterEach(() => {
    snapshot.replaceCatalogProviders([]);
    vi.unstubAllGlobals();
});

describe("checking a key against a stored endpoint", () => {
    it("refuses one whose name now resolves to a private address", async () => {
        const global = vi.fn();
        vi.stubGlobal("fetch", global);
        const check = await checkProviderKey("rebound", "sk-test-abcdefgh");
        expect(check).toMatchObject({ state: "unverified", code: "network" });
        expect(network.fetched).toEqual([]);
        expect(global).not.toHaveBeenCalled();
    });

    it("asks a public one through the guarded fetch, never the plain one", async () => {
        const global = vi.fn();
        vi.stubGlobal("fetch", global);
        const check = await checkProviderKey("honest", "sk-test-abcdefgh");
        expect(check.state).toBe("valid");
        expect(network.fetched).toEqual(["https://honest.example/v1/models"]);
        expect(global).not.toHaveBeenCalled();
    });
});
