/**
 * Where players connect from is shown to the people running a game server only
 * while an administrator lets it be - hidden by default. Hidden, every address is
 * an opaque per-server reference the screen can still act on; administrators
 * see the real one either way, and enforcement never goes through the masking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    shared: null as string | null,
    key: null as string | null,
    isAdmin: false,
    signedIn: true
}));

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) =>
        key === "games.address-ref-key" ? state.key : state.shared,
    setSetting: async (key: string, value: string) => {
        if (key === "games.address-ref-key") state.key = value;
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => {
        if (!state.signedIn) throw new Error("NEXT_REDIRECT");
        return { id: "viewer", isAdmin: state.isAdmin };
    }
}));

const { forViewer } = await import("@polaris-app/game-servers/src/lib/minecraft/player-access");
const refs = await import("@polaris-app/game-servers/src/lib/minecraft/address-refs");
const { addressShown } = await import("@polaris-app/game-servers/src/lib/minecraft/address-label");

type View = Parameters<typeof forViewer>[0];

const rule = (id: string, username: string, address: string, source: string) => ({
    id,
    username,
    address,
    note: null,
    createdAt: "",
    source
});

const view = {
    rules: [
        rule("1", "ada", "203.0.113.7", "session"),
        rule("2", "bob", "198.51.100.4", "manual"),
        rule("3", "cy", "203.0.113.7", "manual"),
        rule("4", "dee", "any", "manual")
    ],
    refusals: [
        { player: "eve", address: "192.0.2.9", why: "", at: "", count: 1 },
        { player: "ada", address: "203.0.113.7", why: "", at: "", count: 1 }
    ],
    links: [],
    bindAddresses: true,
    addressesAvailable: true,
    edition: "java"
} as unknown as View;

const SERVER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const addressesOf = (shown: View) => shown.rules.map((one) => one.address);

describe("player addresses on the players screen", () => {
    beforeEach(() => {
        state.shared = null;
        state.isAdmin = false;
        state.signedIn = true;
    });

    it("hides every address by default, as a reference", async () => {
        const shown = await forViewer(view, undefined, SERVER);
        const [ada, bob, cy, dee] = addressesOf(shown);
        for (const ref of [ada, bob, cy]) expect(refs.isAddressRef(ref!)).toBe(true);
        expect(JSON.stringify(shown)).not.toMatch(/203\.0\.113|198\.51\.100|192\.0\.2/);
        // An observed address reads the same wherever it was observed, so a
        // sign-in and a refused join from one line read as one.
        expect(ada).toBe(shown.refusals[1]!.address);
        expect(ada).not.toBe(bob);
        expect(dee).toBe("any");
        // A typed address reads as its own row, never as the address: typing a
        // guess must not reveal whether a player connects from it.
        expect(cy).not.toBe(ada);
        expect(refs.isAddressRef(shown.refusals[0]!.address!)).toBe(true);
        // The stored view is untouched: enforcement reads the rows themselves.
        expect(view.rules[0]!.address).toBe("203.0.113.7");
    });

    it("gives another server different references for the same address", async () => {
        const here = addressesOf(await forViewer(view, undefined, SERVER));
        const there = addressesOf(await forViewer(view, undefined, OTHER));
        expect(here[0]).not.toBe(there[0]);
    });

    it("hides them when an administrator has turned sharing off", async () => {
        state.shared = "false";
        expect(refs.isAddressRef(addressesOf(await forViewer(view, undefined, SERVER))[1]!)).toBe(
            true
        );
    });

    it("shows the real ones once an administrator shares them", async () => {
        state.shared = "true";
        expect(addressesOf(await forViewer(view, undefined, SERVER))[0]).toBe("203.0.113.7");
    });

    it("still shows them to an administrator", async () => {
        state.isAdmin = true;
        expect(addressesOf(await forViewer(view, undefined, SERVER))[0]).toBe("203.0.113.7");
    });

    it("shows a caller it cannot identify only references", async () => {
        state.signedIn = false;
        state.shared = "true";
        expect(refs.isAddressRef(addressesOf(await forViewer(view, undefined, SERVER))[0]!)).toBe(
            true
        );
    });
});

describe("acting on an address by its reference", () => {
    it("resolves a reference only to an address the server already holds", async () => {
        const key = await refs.addressRefKey();
        const held = ["203.0.113.7", "198.51.100.4"];
        const ref = refs.addressRef(key, SERVER, "198.51.100.4");
        expect(refs.resolveAddressRef(key, SERVER, ref, held)).toBe("198.51.100.4");
        // Not on this server, not from another server, not a made-up one.
        expect(refs.resolveAddressRef(key, OTHER, ref, held)).toBeNull();
        expect(refs.resolveAddressRef(key, SERVER, ref, ["203.0.113.7"])).toBeNull();
        expect(refs.resolveAddressRef(key, SERVER, "ref-0000000000", held)).toBeNull();
        expect(refs.resolveAddressRef(key, SERVER, "198.51.100.4", held)).toBeNull();
    });

    it("keeps the key it created, so references stay stable", async () => {
        expect(await refs.addressRefKey()).toBe(await refs.addressRefKey());
    });

    it("labels a reference without the address in it", () => {
        const label = (ref: string) => `Address ${ref}`;
        expect(addressShown("ref-3f9ac21b00", label)).toBe("Address 3F9A-C21B");
        expect(addressShown("203.0.113.7", label)).toBe("203.0.113.7");
    });
});
