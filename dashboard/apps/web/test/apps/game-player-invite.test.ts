/**
 * A player linked to an account is told in Chat, by a direct message from whoever
 * linked them; only when that cannot be sent does a line land in their bell. The
 * caller learns which, so the players page can say where the person heard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";

const sent = vi.hoisted(() => ({
    result: "chat" as "chat" | null,
    invites: [] as { inviterId: string; targetId: string; player: string; fallback: string }[],
    notices: [] as { userId: string; title: string; body: string }[]
}));

vi.mock("@/lib/chat/game-server-card-post", () => ({
    sendGamePlayerInvite: async (input: (typeof sent.invites)[number]) => {
        sent.invites.push(input);
        return sent.result;
    }
}));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: (typeof sent.notices)[number]) => {
        sent.notices.push(input);
        return "created";
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => ({ name: "Javier", username: "javier" }) },
        gamePlayerAccess: { findMany: async () => [] }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/games-service", () => ({
    gameServerFacts: async () => ({ name: "lbr", address: "lbr.example.test" })
}));

const notice = await import("@polaris-app/game-servers/src/lib/minecraft/player-notice");

const NOTICE = {
    ownerId: "owner",
    installedAppId: SERVER,
    actorId: "javier",
    userId: "demo-account",
    player: "demo",
    followSignIns: true,
    bindAddresses: true
};

beforeEach(() => {
    sent.result = "chat";
    sent.invites = [];
    sent.notices = [];
});

describe("telling a linked player", () => {
    it("sends the invite in Chat from whoever linked them, and nothing to the bell", async () => {
        expect(await notice.tellLinkedPlayer(NOTICE)).toBe("chat");
        expect(sent.invites).toHaveLength(1);
        expect(sent.invites[0]).toMatchObject({
            inviterId: "javier",
            targetId: "demo-account",
            player: "demo"
        });
        // The words a text-only screen shows name the server, the address and the player.
        expect(sent.invites[0]!.fallback).toContain("lbr");
        expect(sent.invites[0]!.fallback).toContain("lbr.example.test");
        expect(sent.notices).toEqual([]);
    });

    it("falls back to the bell when Chat could not take the message", async () => {
        sent.result = null;
        expect(await notice.tellLinkedPlayer(NOTICE)).toBe("notification");
        expect(sent.notices).toHaveLength(1);
        expect(sent.notices[0]).toMatchObject({ userId: "demo-account" });
        expect(sent.notices[0]!.body).toContain("lbr.example.test");
    });
});

describe("where an invited player may join from", () => {
    it("follows sign-ins first, then an open server or an any rule, then the list", () => {
        const base = { followSignIns: false, bindAddresses: true, addresses: [] as string[] };
        expect(notice.joinFromOf({ ...base, followSignIns: true })).toEqual({ kind: "signIns" });
        expect(notice.joinFromOf({ ...base, bindAddresses: false })).toEqual({ kind: "anywhere" });
        expect(notice.joinFromOf({ ...base, addresses: ["any"] })).toEqual({ kind: "anywhere" });
        expect(notice.joinFromOf({ ...base, addresses: ["192.0.2.4"] })).toEqual({
            kind: "addresses",
            addresses: ["192.0.2.4"]
        });
        expect(notice.joinFromOf(base)).toEqual({ kind: "ask" });
    });
});
