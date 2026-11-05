/**
 * The machines a Places picker offers, read a page at a time.
 *
 * The servers are the house owner's, whoever is reading, under the right to see
 * the house; the machine Polaris runs on comes first only where the screen asks
 * for it, only on the first page, and only when the search matches it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const SERVER = "0b6c1f1e-4b8e-4a3a-9a63-6f1c2e9d1a01";

const requireHome = vi.fn(async (_permission: string) => ({
    user: { id: "viewer-1" },
    install: { id: "install-1", ownerId: OWNER }
}));

const readServerOptions = vi.fn(async (_owner: string, _request: Record<string, unknown>) => ({
    items: [
        {
            id: SERVER,
            name: "garage",
            address: "192.0.2.10",
            os: null,
            environment: "home",
            root: true,
            online: true
        }
    ],
    next: "cursor-2"
}));

vi.mock("@/lib/server-options", () => ({
    readServerOptions: (owner: string, request: Record<string, unknown>) =>
        readServerOptions(owner, request)
}));

vi.mock("@polaris-app/places/src/lib/access", () => ({
    requireHome: (permission: string) => requireHome(permission),
    requireHomeInstall: vi.fn(),
    requireHomeShared: vi.fn()
}));

vi.mock("@polaris-app/places/src/lib/i18n", async (original) => {
    const real = await original<typeof import("@polaris-app/places/src/lib/i18n")>();
    return { ...real, placesT: async () => real.placesTIn("en-US") };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const { machineOptionsAction } = await import("@polaris-app/places/src/screens/actions");

beforeEach(() => {
    requireHome.mockClear();
    readServerOptions.mockClear();
});

describe("machineOptionsAction", () => {
    it("reads the house owner's servers a page at a time, under the right to see the house", async () => {
        const page = await machineOptionsAction({ query: "gar", cursor: "cursor-1" });
        expect(requireHome).toHaveBeenCalledWith("home.read");
        expect(readServerOptions).toHaveBeenCalledWith(
            OWNER,
            expect.objectContaining({ query: "gar", cursor: "cursor-1", limit: 50, filter: {} })
        );
        expect(page).toEqual({
            items: [{ id: SERVER, name: "garage", address: "192.0.2.10" }],
            next: "cursor-2"
        });
    });

    it("offers this machine first on the first page only, when asked and matched", async () => {
        const first = await machineOptionsAction({ includeLocal: true });
        expect("items" in first && first.items.map((item) => item.id)).toEqual(["local", SERVER]);
        const later = await machineOptionsAction({ includeLocal: true, cursor: "cursor-2" });
        expect("items" in later && later.items.map((item) => item.id)).toEqual([SERVER]);
        const searched = await machineOptionsAction({ includeLocal: true, query: "garage" });
        expect("items" in searched && searched.items.map((item) => item.id)).toEqual([SERVER]);
        const without = await machineOptionsAction({});
        expect("items" in without && without.items.map((item) => item.id)).toEqual([SERVER]);
    });

    it("names this machine by id without reading any server", async () => {
        const page = await machineOptionsAction({ ids: ["local"], includeLocal: true });
        expect(readServerOptions).not.toHaveBeenCalled();
        expect("items" in page && page.items.map((item) => item.id)).toEqual(["local"]);
    });

    it("refuses a malformed request without reading", async () => {
        const page = await machineOptionsAction({ ids: ["not-an-id"] });
        expect("error" in page).toBe(true);
        expect(readServerOptions).not.toHaveBeenCalled();
    });
});
