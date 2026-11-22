/**
 * The connectors directory: the catalog and the connections as one list,
 * every server once, with where it stands.
 */

import { describe, expect, it } from "vitest";
import { hashState, stateConnectorId, tokenExpiring } from "@/lib/polar/connectors/oauth";
import {
    buildDirectory,
    directoryCounts,
    directoryQuerySchema,
    needsAttention,
    pageDirectory,
    queryDirectory
} from "@/lib/polar/connectors/directory";
import { CONNECTOR_CATALOG } from "@/lib/polar/connectors/catalog";

const ALL = { q: "", category: "all", view: "all" } as const;

function row(id: string, url: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        name: id,
        url,
        auth: "none" as const,
        signedIn: false,
        status: "ok" as const,
        ...extra
    };
}

describe("building the directory", () => {
    it("lists a connected catalog server once, carrying its connection", () => {
        const items = buildDirectory([row("s1", "https://mcp.stripe.com")]);
        const stripe = items.filter((item) => item.name === "Stripe");
        expect(stripe).toHaveLength(1);
        expect(stripe[0]).toMatchObject({
            key: "catalog:stripe",
            kind: "catalog",
            connectionIds: ["s1"],
            state: "connected"
        });
        expect(items).toHaveLength(CONNECTOR_CATALOG.length);
        // Connected first.
        expect(items[0]?.key).toBe("catalog:stripe");
    });

    it("matches the catalog address with or without the trailing slash", () => {
        const items = buildDirectory([row("s1", "https://mcp.stripe.com/")]);
        expect(items.filter((item) => item.entryId === "stripe")[0]?.connectionIds).toEqual(["s1"]);
    });

    it("keeps a server added by its address as its own entry, marked custom", () => {
        const items = buildDirectory([row("lin", "https://mcp.linear.app/mcp")]);
        const custom = items.find((item) => item.kind === "custom");
        expect(custom).toMatchObject({
            key: "custom:lin",
            category: "custom",
            vendor: "mcp.linear.app",
            connectionIds: ["lin"]
        });
        expect(items).toHaveLength(CONNECTOR_CATALOG.length + 1);
    });

    it("puts every store of a template under its one entry", () => {
        const items = buildDirectory([
            row("a", "https://one.myshopify.com/api/mcp"),
            row("b", "https://two.myshopify.com/api/mcp")
        ]);
        const shop = items.filter((item) => item.entryId === "shopify-storefront");
        expect(shop).toHaveLength(1);
        expect(shop[0]?.connectionIds).toEqual(["a", "b"]);
        expect(items.some((item) => item.kind === "custom")).toBe(false);
    });

    it("says a connection needs attention when its sign-in ran out or it does not answer", () => {
        expect(needsAttention({ auth: "oauth", signedIn: false, status: "new" })).toBe(true);
        expect(needsAttention({ auth: "oauth", signedIn: true, status: "sign_in" })).toBe(true);
        expect(needsAttention({ auth: "none", signedIn: false, status: "error" })).toBe(true);
        expect(needsAttention({ auth: "oauth", signedIn: true, status: "ok" })).toBe(false);
        expect(needsAttention({ auth: "bearer", signedIn: true, status: "new" })).toBe(false);
        const items = buildDirectory([
            row("s1", "https://mcp.stripe.com", { auth: "oauth", signedIn: true, status: "sign_in" }),
            row("lin", "https://mcp.linear.app/mcp")
        ]);
        expect(items[0]).toMatchObject({ key: "catalog:stripe", state: "attention" });
    });

    it("marks an entry the host list refuses as unavailable, unless already connected", () => {
        const items = buildDirectory([], ["mcp.stripe.com"]);
        expect(items.find((item) => item.entryId === "stripe")?.state).toBe("available");
        expect(items.find((item) => item.entryId === "binance")?.state).toBe("unavailable");
        // A template is checked once its store is typed, not here.
        expect(items.find((item) => item.entryId === "shopify-storefront")?.state).toBe("available");
    });
});

describe("searching and paging the directory", () => {
    const items = buildDirectory([
        row("s1", "https://mcp.stripe.com"),
        row("lin", "https://mcp.linear.app/mcp", { status: "error" })
    ]);

    it("filters by view, category and every word of the search, ignoring accents", () => {
        expect(queryDirectory(items, { ...ALL, view: "connected" }).map((item) => item.key)).toEqual([
            "custom:lin",
            "catalog:stripe"
        ]);
        expect(queryDirectory(items, { ...ALL, view: "attention" }).map((item) => item.key)).toEqual([
            "custom:lin"
        ]);
        expect(queryDirectory(items, { ...ALL, category: "custom" })).toHaveLength(1);
        expect(queryDirectory(items, { ...ALL, q: "ADOBE target" }).map((item) => item.entryId)).toEqual([
            "adobe-target"
        ]);
        expect(queryDirectory(items, { ...ALL, q: "bóoking" }).map((item) => item.entryId)).toEqual([
            "booking"
        ]);
        expect(queryDirectory(items, { ...ALL, q: "nothing like this" })).toEqual([]);
    });

    it("counts each view whatever the search", () => {
        expect(directoryCounts(items)).toEqual({
            all: CONNECTOR_CATALOG.length + 1,
            connected: 2,
            attention: 1
        });
    });

    it("pages with a cursor until the last page", () => {
        const first = pageDirectory(items, ALL, 0, 5);
        expect(first.items).toHaveLength(5);
        expect(first.next).toBe(5);
        expect(first.total).toBe(items.length);
        const seen = new Set(first.items.map((item) => item.key));
        let cursor = first.next;
        while (cursor !== null) {
            const page = pageDirectory(items, ALL, cursor, 5);
            for (const item of page.items) {
                expect(seen.has(item.key)).toBe(false);
                seen.add(item.key);
            }
            cursor = page.next;
        }
        expect(seen.size).toBe(items.length);
    });

    it("reads the route's query string strictly", () => {
        expect(directoryQuerySchema.parse({})).toEqual({
            q: "",
            category: "all",
            view: "all",
            cursor: 0,
            size: 24
        });
        expect(directoryQuerySchema.parse({ q: "  stripe ", cursor: "24" })).toMatchObject({
            q: "stripe",
            cursor: 24
        });
        expect(directoryQuerySchema.safeParse({ view: "everything" }).success).toBe(false);
        expect(directoryQuerySchema.safeParse({ category: "nope" }).success).toBe(false);
        expect(directoryQuerySchema.safeParse({ size: "1000" }).success).toBe(false);
        expect(directoryQuerySchema.safeParse({ q: "x".repeat(101) }).success).toBe(false);
    });
});

describe("the OAuth state a sign-in carries", () => {
    const id = "0190a000-0000-7000-8000-000000000009";

    it("names its connector and nothing else", () => {
        expect(stateConnectorId(`${id}.abc`)).toBe(id);
        expect(stateConnectorId("not-a-connector.abc")).toBeNull();
        expect(stateConnectorId("")).toBeNull();
    });

    it("is stored only as a hash", () => {
        const state = `${id}.secret`;
        expect(hashState(state)).not.toContain("secret");
        expect(hashState(state)).toBe(hashState(state));
        expect(hashState(state)).not.toBe(hashState(`${id}.other`));
    });

    it("refreshes a token a minute before it ends, and never one without an end", () => {
        const now = 1_000_000;
        expect(tokenExpiring({ expiresAt: now + 30_000 }, now)).toBe(true);
        expect(tokenExpiring({ expiresAt: now + 120_000 }, now)).toBe(false);
        expect(tokenExpiring({ expiresAt: null }, now)).toBe(false);
    });
});
