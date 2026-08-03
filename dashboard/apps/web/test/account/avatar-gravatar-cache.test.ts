/**
 * How long a Gravatar lookup is remembered.
 *
 * The bug this pins: every lookup that did not produce a picture - including a
 * four-second timeout on a home connection - was remembered as "this address has
 * no Gravatar" for a full day, with nothing able to clear it but a restart. One
 * slow moment took the picture off every account until the next deploy.
 *
 * So the two cases are separated here: an answer from Gravatar is cached, and a
 * failure to reach it is retried shortly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let now = 1_700_000_000_000;
let fetches = 0;
let respond: () => Promise<Response>;

vi.mock("@polaris/db", () => ({
    prisma: {
        userAvatar: { findUnique: async () => null },
        user: { findUnique: async () => ({ email: "ada@example.com" }) }
    }
}));

vi.mock("@/lib/setting-store", () => ({ getSetting: async () => null, setSetting: async () => undefined }));

vi.mock("@/lib/storage-target", () => ({
    AUTOMATIC_TARGET: "auto",
    LOCAL_TARGET: "local",
    driverForTarget: async () => ({ dispose: async () => undefined }),
    resolveStorageTarget: async () => ({ id: "local" }),
    safeName: (value: string) => value,
    storageTargetOptions: async () => []
}));

const { forgetGravatar, resolveAvatar } = await import("../../src/lib/avatar-service");

/** A 200 carrying a one-pixel PNG, which is what "this address has a picture"
 *  looks like on the wire. */
function png(): Response {
    const bytes = new Uint8Array(32);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Response(bytes, { status: 200 });
}

beforeEach(() => {
    now = 1_700_000_000_000;
    fetches = 0;
    respond = async () => png();
    forgetGravatar("ada@example.com");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubGlobal("fetch", async () => {
        fetches += 1;
        return respond();
    });
});

describe("a Gravatar lookup that never got an answer", () => {
    it("is asked again a minute later rather than standing in for a day", async () => {
        respond = async () => {
            throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
        };
        expect(await resolveAvatar("u1")).toBeNull();
        expect(fetches).toBe(1);

        // Straight away it is not retried - a board full of faces must not turn
        // one dead network into one request per person.
        expect(await resolveAvatar("u1")).toBeNull();
        expect(fetches).toBe(1);

        now += 61_000;
        respond = async () => png();
        expect(await resolveAvatar("u1")).not.toBeNull();
        expect(fetches).toBe(2);
    });

    it("treats a fault at Gravatar's end the same way, since it says nothing about the address", async () => {
        respond = async () => new Response(null, { status: 429 });
        expect(await resolveAvatar("u1")).toBeNull();

        now += 61_000;
        respond = async () => png();
        expect(await resolveAvatar("u1")).not.toBeNull();
        expect(fetches).toBe(2);
    });
});

describe("an answer from Gravatar", () => {
    it("keeps a picture for the day, so a face is not re-fetched per screen", async () => {
        expect(await resolveAvatar("u1")).not.toBeNull();
        now += 60 * 60 * 1000;
        expect(await resolveAvatar("u1")).not.toBeNull();
        expect(fetches).toBe(1);
    });

    it("keeps a 'nobody here' for the day too - it is the common case", async () => {
        respond = async () => new Response(null, { status: 404 });
        expect(await resolveAvatar("u1")).toBeNull();
        now += 60 * 60 * 1000;
        expect(await resolveAvatar("u1")).toBeNull();
        expect(fetches).toBe(1);
    });
});
