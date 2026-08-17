/**
 * The ticket a browser is given for the media server.
 *
 * It is the whole of the authorization: once it is signed, the media server does
 * not ask Polaris anything else, so every limit on what somebody can do in a
 * call has to already be inside it. That makes the grant worth asserting field
 * by field rather than trusting the shape of the call that built it - a token
 * that accidentally carried no room, or carried permission to publish data, or
 * never expired, would work perfectly in every manual test.
 *
 * The name is checked too, and for the same reason it is read from the database
 * rather than passed in: whatever is in the token is what everybody else in the
 * room sees written under the picture.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const participants: Record<string, { name: string }> = {
    "seat-1": { name: "Ada" }
};

vi.mock("@polaris/db", () => ({
    prisma: {
        meetingParticipant: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                participants[where.id] ?? null
        },
        installedApp: { findFirst: async () => null },
        deployTarget: { findFirst: async () => null }
    }
}));

let stored: { enabled: boolean; config: Record<string, unknown> } | null = null;
let secret: string | null = null;
const saved: unknown[] = [];

vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => stored,
    getIntegrationSecret: async () => secret,
    upsertIntegration: async (provider: string, input: unknown) => {
        saved.push({ provider, input });
    }
}));

vi.mock("@/lib/apps/install-service", () => ({ installApp: async () => undefined }));
vi.mock("@/lib/apps/install-secret", () => ({ installEnvSecret: async () => null }));
vi.mock("@/lib/home/side-service", () => ({
    assertServer: async () => undefined,
    findService: async () => null,
    serviceUrls: async () => null
}));

const calls = await import("@/lib/chat/call-server");

/** The claims, without verifying the signature - what is being asserted is what
 *  Polaris put in, not that the library can sign. */
function claims(token: string): Record<string, unknown> {
    const body = token.split(".")[1] ?? "";
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}

const endpoint = { url: "wss://calls.example.com", apiKey: "polaris", apiSecret: "s".repeat(32) };

beforeEach(() => {
    stored = null;
    secret = null;
    saved.length = 0;
});

describe("the ticket for the media server", () => {
    it("is good for one room, under the seat that asked for it", async () => {
        const grant = claims(await calls.joinToken(endpoint, "meeting-9", "seat-1"));
        const video = grant.video as Record<string, unknown>;

        expect(grant.sub).toBe("seat-1");
        expect(grant.name).toBe("Ada");
        expect(video.room).toBe("meeting-9");
        expect(video.roomJoin).toBe(true);
        expect(video.canPublish).toBe(true);
        expect(video.canSubscribe).toBe(true);
    });

    it("carries nothing on the data channel", async () => {
        const grant = claims(await calls.joinToken(endpoint, "meeting-9", "seat-1"));

        // Everything Polaris has to say about a call goes through Polaris, where
        // it can be checked. A browser that could publish data to the room could
        // say things about the call that nothing verified.
        expect((grant.video as Record<string, unknown>).canPublishData).toBe(false);
    });

    it("lets a browser say it has stopped listening, and nothing else", async () => {
        const grant = claims(await calls.joinToken(endpoint, "meeting-9", "seat-1"));
        const video = grant.video as Record<string, unknown>;

        // Deafening is the one thing about somebody's controls the media server
        // cannot work out for itself, so it rides in their own attributes.
        expect(video.canUpdateOwnMetadata).toBe(true);
        // Its own room and nobody else's: no administration, no listing, no
        // recording.
        expect(video.roomAdmin).toBeUndefined();
        expect(video.roomList).toBeUndefined();
        expect(video.roomRecord).toBeUndefined();
    });

    it("stops being worth anything within minutes", async () => {
        const grant = claims(await calls.joinToken(endpoint, "meeting-9", "seat-1"));
        const life = (grant.exp as number) - (grant.nbf as number);

        // Long enough to answer a ringing call, short enough that one taken off
        // a screen is worth nothing by the time anybody reads it.
        expect(life).toBeGreaterThan(0);
        expect(life).toBeLessThanOrEqual(15 * 60);
    });

    it("says nothing about somebody who is not in the call", async () => {
        const grant = claims(await calls.joinToken(endpoint, "meeting-9", "gone"));

        // A seat that has been given up leaves a token with no label at all
        // rather than one that inherits whatever the caller passed. The seat is
        // still the identity, so the media server refuses it on its own terms.
        expect(grant.sub).toBe("gone");
        expect(grant.name ?? "").toBe("");
    });
});

describe("where calls run", () => {
    it("is nowhere until somebody sets it up", async () => {
        expect(await calls.callServer()).toBeNull();
    });

    it("is nowhere when an address was typed without its key", async () => {
        stored = { enabled: true, config: { url: "wss://calls.example.com" } };
        secret = null;

        // Half a pairing signs nothing, and a call that tried would fail at the
        // door of the media server rather than here.
        expect(await calls.callServer()).toBeNull();
    });

    it("is the address somebody typed, once both halves are there", async () => {
        stored = { enabled: true, config: { url: "wss://calls.example.com", apiKey: "polaris" } };
        secret = "kept";

        expect(await calls.callServer()).toEqual({
            url: "wss://calls.example.com",
            apiKey: "polaris",
            apiSecret: "kept"
        });
    });

    it("refuses an address that is not one", async () => {
        await expect(calls.setCallServer("calls.example.com", "k", "s")).rejects.toThrow(
            /wss:\/\//
        );
        await expect(calls.setCallServer("http://calls.example.com", "k", "s")).rejects.toThrow(
            /wss:\/\//
        );
        expect(saved).toHaveLength(0);
    });

    it("clears the pairing outright when the address is emptied", async () => {
        stored = { enabled: true, config: { url: "wss://calls.example.com", apiKey: "polaris" } };
        await calls.setCallServer("   ", "", "");

        const written = saved[0] as { input: { config: Record<string, unknown>; secret: unknown } };
        expect(written.input.config.url).toBeUndefined();
        expect(written.input.config.apiKey).toBeUndefined();
        // The stored key goes with it. Leaving it behind would mean a later save
        // of an address alone silently reused a secret nobody remembers setting.
        expect(written.input.secret).toBeNull();
    });

    it("leaves the stored key alone when only the address was changed", async () => {
        stored = { enabled: true, config: { url: "wss://old.example.com", apiKey: "polaris" } };
        await calls.setCallServer("wss://calls.example.com/", "polaris", "");

        const written = saved[0] as { input: { config: Record<string, unknown>; secret?: unknown } };
        expect(written.input.config.url).toBe("wss://calls.example.com");
        expect("secret" in written.input).toBe(false);
    });
});
