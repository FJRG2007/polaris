/**
 * Bringing somebody into a call that is already running.
 *
 * Everybody picked is being added to the CALL, and in a group most of them are
 * in the conversation already. Adding those again is refused where the group's
 * owner keeps adding people to themselves, and the refusal would stop the
 * telephone ringing for the person actually being brought in - so only the
 * people who are not in the conversation are added to it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let members = ["ada", "grace", "hopper"];
let added: string[][] = [];
let rang: { audience: readonly string[] } | null = null;

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/blocks", () => ({ blockersOf: async () => new Set<string>() }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => null,
    getIntegrationSecret: async () => null
}));
vi.mock("@/lib/chat/meeting-events", () => ({ publishMeetingEvent: () => undefined }));
vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (frame: { kind: string; audience?: readonly string[] }) => {
        if (frame.kind === "call") rang = { audience: frame.audience ?? [] };
    }
}));
vi.mock("@/lib/chat/access", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/chat/access");
    return { ...actual, requireChannel: async () => undefined };
});

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: {
            findUnique: async () => ({ id: "meeting-1", channelId: "channel-1", endedAt: null })
        },
        chatChannel: {
            findUnique: async () => ({
                kind: "group",
                members: members.map((userId) => ({ userId }))
            })
        },
        meetingParticipant: { count: async () => 2 }
    }
}));

const meetings = await import("@/lib/chat/meetings");

const ada = { id: "ada", name: "Ada" };

beforeEach(() => {
    members = ["ada", "grace", "hopper"];
    added = [];
    rang = null;
});

/** The call's own invite, with the "add them to the conversation" half spied on. */
async function bringIn(userIds: string[]) {
    return meetings.inviteToCall(
        ada,
        "meeting-1",
        userIds,
        async (_channelId: string, wanted: readonly string[]) => void added.push([...wanted]),
        async () => "group-1"
    );
}

describe("bringing somebody into a call in a group", () => {
    it("adds only the people who are not in the conversation already", async () => {
        await bringIn(["hopper", "turing"]);
        expect(added).toEqual([["turing"]]);
    });

    it("adds nobody when everybody picked is already in it, and still rings them", async () => {
        const result = await bringIn(["grace", "hopper"]);
        expect(added).toEqual([]);
        expect(rang?.audience).toEqual(["grace", "hopper"]);
        expect(result.moved).toBe(false);
    });
});
