/**
 * The address the call server hands out, when it stops being this network's.
 *
 * The failure this exists for is the one that cost days. A media server asks a
 * STUN server for its public address once, as it starts, and hands that answer
 * to every browser for the life of the container. On a line whose address is not
 * permanent, the day it changes is the day calls from outside go silent - and
 * nothing says so, because signalling still works: the call connects, both faces
 * appear, both rings light up, and the sound is sent to an address that belongs
 * to somebody else now.
 *
 * It is indistinguishable, from the screen, from a router that was never
 * configured. So the operator is sent to check port forwarding they set up weeks
 * ago and which was never the problem.
 *
 * What is asserted here is the doctrine rather than the plumbing: Polaris fixes
 * what it can fix, tells an administrator what it did, and only asks a person
 * for what is genuinely theirs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let settings: Record<string, string | null> = {};
let publicIp: string | null = "85.87.158.186";
let shipped = true;
let startedAt: string | null = "2026-08-26T13:24:22.000Z";
let restartFails = false;

const restarted: string[] = [];
const notified: { title: string; body: string; actionRequired?: boolean }[] = [];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings[key] ?? null,
    setSetting: async (key: string, value: string | null) => {
        settings[key] = value;
    }
}));

vi.mock("@/lib/network-service", () => ({ detectPublicIp: async () => publicIp }));

vi.mock("@/lib/chat/call-server", () => ({
    callServer: async () => ({ shipped, url: "http://127.0.0.1:7880" })
}));

vi.mock("@/lib/docker-service", () => ({
    localDockerDriver: () => ({
        listContainers: async () => [{ id: "abc123", composeService: "livekit" }],
        inspect: async () => ({ startedAt }),
        restart: async (id: string) => {
            if (restartFails) throw new Error("no engine");
            restarted.push(id);
        },
        dispose: async () => {}
    })
}));

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: { user: { findMany: async () => [{ id: "admin-1" }] } }
}));

vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (input: { title: string; body: string; actionRequired?: boolean }) => {
        notified.push(input);
    }
}));

const watch = await import("@/lib/chat/call-address-watch");

beforeEach(() => {
    settings = {};
    publicIp = "85.87.158.186";
    shipped = true;
    startedAt = "2026-08-26T13:24:22.000Z";
    restartFails = false;
    restarted.length = 0;
    notified.length = 0;
});

describe("the address a call is sent to", () => {
    it("says nothing the first time it looks", async () => {
        // A fresh install has not seen this address change; it has seen it once.
        // Announcing that would make every new deployment report a fault.
        const state = await watch.watchCallAddress();

        expect(state.stale).toBe(false);
        expect(notified).toHaveLength(0);
        expect(settings["chat.calls.publicIpSeen"]).toBe("85.87.158.186");
    });

    it("repairs it and says so when the line moved under a running server", async () => {
        settings["chat.calls.publicIpSeen"] = "85.87.153.18";

        const state = await watch.watchCallAddress();

        // Started in August, address changed today: what it is handing out is an
        // address from before, and restarting is the whole repair.
        expect(state.stale).toBe(true);
        expect(state.healed).toBe(true);
        expect(restarted).toEqual(["abc123"]);
        expect(notified[0]?.title).toContain("repaired");
        // Nothing for anybody to do, so nothing is demanded of them.
        expect(notified[0]?.actionRequired).toBe(false);
        expect(notified[0]?.body).toContain("85.87.158.186");
    });

    it("asks for help only when it genuinely cannot help itself", async () => {
        settings["chat.calls.publicIpSeen"] = "85.87.153.18";
        restartFails = true;

        const state = await watch.watchCallAddress();

        expect(state.healed).toBe(false);
        expect(state.cannotHeal).toBeTruthy();
        expect(notified[0]?.actionRequired).toBe(true);
        // Names what is actually wrong. The screen that sent people to their
        // router was the whole problem: the forwarding was already right.
        expect(notified[0]?.title).toContain("cannot reach");
    });

    it("leaves a server that started after the change alone", async () => {
        settings["chat.calls.publicIpSeen"] = "85.87.153.18";
        settings["chat.calls.publicIpChangedAt"] = "2026-09-01T00:00:00.000Z";
        publicIp = "85.87.153.18";
        startedAt = "2026-09-02T00:00:00.000Z";

        const state = await watch.watchCallAddress();

        expect(state.stale).toBe(false);
        expect(restarted).toHaveLength(0);
        // And forgets the change, so this does not ask the same question every
        // ten minutes for the life of the deployment.
        expect(settings["chat.calls.publicIpChangedAt"]).toBeNull();
    });

    it("does not touch a call server somebody else runs", async () => {
        settings["chat.calls.publicIpSeen"] = "85.87.153.18";
        shipped = false;

        const state = await watch.watchCallAddress();

        // It is on their network and learned its address there. Restarting
        // somebody else's server over a change on this line would be Polaris
        // reaching well past what it was asked to look after.
        expect(state.stale).toBe(false);
        expect(restarted).toHaveLength(0);
        expect(notified).toHaveLength(0);
    });

    it("stays quiet on a connection with no public address", async () => {
        settings["chat.calls.publicIpSeen"] = "85.87.153.18";
        publicIp = null;

        const state = await watch.watchCallAddress();

        // Calls from outside cannot work either way, so there is nothing here
        // that would help anybody - and the address on file is not overwritten
        // with a blank on a line that is briefly down.
        expect(state.stale).toBe(false);
        expect(notified).toHaveLength(0);
        expect(settings["chat.calls.publicIpSeen"]).toBe("85.87.153.18");
    });
});
