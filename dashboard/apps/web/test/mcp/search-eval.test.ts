/**
 * What people actually type at an assistant, in Spanish and English and with
 * their typos, against one account's worth of things across apps. Each phrase
 * names the one hit that has to come first; a change to the matcher or a
 * provider that sends any of them elsewhere is a change an assistant's person
 * would notice.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));

const { searchEverywhere } = await import("@/lib/mcp/search");

import type { McpSearchHit, McpSearchProvider } from "@/lib/mcp/search";

function provider(app: string, scope: string, hits: McpSearchHit[]): McpSearchProvider {
    return {
        id: `${app}.eval`,
        app,
        category: "home",
        scope: scope as never,
        search: async () => hits
    };
}

const PROVIDERS = [
    provider("places", "places.read", [
        { id: "lock", name: "Puerta principal", kind: "device", keywords: ["lock"], next: [] },
        {
            id: "lamp",
            name: "Lámpara",
            kind: "device",
            where: "Casa, Salón",
            keywords: ["light"],
            next: []
        },
        {
            id: "kitchen",
            name: "Luz cocina",
            kind: "device",
            where: "Casa, Cocina",
            keywords: ["light"],
            next: []
        },
        {
            id: "split",
            name: "Split dormitorio",
            kind: "device",
            keywords: ["climate"],
            next: []
        },
        { id: "cam-in", name: "Entrada", kind: "camera", where: "Casa", next: [] },
        { id: "cam-garden", name: "Jardín trasero", kind: "camera", where: "Casa", next: [] }
    ]),
    provider("game-servers", "games.read", [
        {
            id: "mc",
            name: "Survival",
            kind: "game server",
            keywords: ["minecraft", "paper"],
            next: []
        },
        { id: "ark", name: "Isla", kind: "game server", keywords: ["ark"], next: [] }
    ]),
    provider("notes", "notes.use", [
        { id: "n1", name: "Lista de la compra", kind: "note", next: [] },
        { id: "n2", name: "Ideas servidor", kind: "note", next: [] }
    ])
];

const caller = {
    userId: "user-1",
    isAdmin: false,
    scopes: ["places.read", "games.read", "notes.use"] as never,
    grantId: "grant-1"
};

async function first(query: string): Promise<string | undefined> {
    const answer = await searchEverywhere({
        query,
        caller,
        providers: PROVIDERS,
        tools: [],
        limit: 5
    });
    return answer.matched ? answer.refs[0]?.id : undefined;
}

describe("polaris_search on real phrases", () => {
    it.each([
        ["puerta", "lock"],
        ["door", "lock"],
        ["abre la puerta", "lock"],
        ["the front door", "lock"],
        ["cerradura", "lock"],
        ["puerat", "lock"],
        ["luz del salon", "lamp"],
        ["luz del salón", "lamp"],
        ["living room light", "lamp"],
        ["luz cocina", "kitchen"],
        ["aire", "split"],
        ["aire acondicionado", "split"],
        ["camara entrada", "cam-in"],
        ["cámara de la entrada", "cam-in"],
        ["entrance camera", "cam-in"],
        ["camara jardin", "cam-garden"],
        ["server de minecraft", "mc"],
        ["servidor minecraft", "mc"],
        ["the minecraft server", "mc"],
        ["minecarft", "mc"],
        ["lista compra", "n1"]
    ])('"%s" finds %s first', async (query, expected) => {
        expect(await first(query)).toBe(expected);
    });

    it("never answers nothing while something is reachable", async () => {
        const answer = await searchEverywhere({
            query: "zebra",
            caller,
            providers: PROVIDERS,
            tools: [],
            limit: 5
        });
        expect(answer.matched).toBe(false);
        expect(answer.refs.length).toBe(5);
        expect(answer.note).toBeTruthy();
    });
});
