/**
 * A notice in a DM or a group moves the conversation up the list, like a message.
 *
 * Somebody added, somebody gone, a call started or hung up is something that
 * happened in that conversation to the person scanning their list, and it used
 * to leave the conversation where it was. A space's channels are ordered by the
 * space rather than by activity, so a notice there moves nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CREATED = new Date("2026-09-24T14:00:00Z");

let kind = "group";
let moved: { id: string; lastMessageAt: Date }[] = [];
const frames: { channelId: string; kind: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            create: async () => ({ createdAt: CREATED, channel: { kind } })
        },
        chatChannel: {
            update: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { lastMessageAt: Date };
            }) => {
                moved.push({ id: where.id, lastMessageAt: data.lastMessageAt });
                return {};
            }
        }
    }
}));

vi.mock("@/lib/chat/live", () => ({
    publishChatChange: (change: { channelId: string; kind: string }) => frames.push(change)
}));

const { postNoticeBody } = await import("@/lib/chat/notices");

beforeEach(() => {
    kind = "group";
    moved = [];
    frames.length = 0;
});

describe("a notice and the conversation list", () => {
    it("moves a group to the top, as of the line", async () => {
        await postNoticeBody("group-1", "Ana left", "actor");
        expect(moved).toEqual([{ id: "group-1", lastMessageAt: CREATED }]);
        expect(frames).toEqual([expect.objectContaining({ channelId: "group-1", kind: "posted" })]);
    });

    it("moves a one-to-one the same way", async () => {
        kind = "dm";
        await postNoticeBody("dm-1", "Call ended", "actor");
        expect(moved.map((row) => row.id)).toEqual(["dm-1"]);
    });

    it("leaves a space's channel where the space put it", async () => {
        kind = "text";
        await postNoticeBody("channel-1", "Ana joined", "actor");
        expect(moved).toEqual([]);
        expect(frames).toHaveLength(1);
    });
});
