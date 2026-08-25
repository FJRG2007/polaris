/**
 * Being told about a conversation, which is not the same as not muting it.
 *
 * The distinction these tests exist to hold: a mute is a silence with an end
 * that takes the unread badge with it, and this is a standing answer to what is
 * worth interrupting for. Collapsing the two - by making "nothing" a mute with
 * no end - would take the badge away with it, and the badge is how somebody
 * finds the busy channel they follow for mentions. Nothing here touches unread.
 *
 * The second is the fallback. A channel says `inherit` until somebody decides
 * otherwise, and `inherit` means the space; a group and a direct message belong
 * to no space, so theirs has to land on `all` rather than on nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    CHAT_CHANNEL_NOTIFY_LEVELS,
    CHAT_NOTIFY_INHERIT,
    CHAT_NOTIFY_LABEL,
    CHAT_NOTIFY_LEVELS,
    chatChannelNotifySchema,
    chatSpaceNotifySchema,
    isChatNotifyLevel,
    resolveChatNotify
} from "@polaris/core";

/** The rows the two lookups read, set per test. */
let channels: { id: string; spaceId: string | null }[] = [];
let memberships: { channelId: string; userId: string; notifyLevel: string }[] = [];
let preferences: { spaceId: string; userId: string; notifyLevel: string }[] = [];

/** Whatever the caller asked for, as a list. The service only ever filters on
 *  equality and `in`, which is all this understands. */
function listed(clause: unknown): string[] | null {
    if (typeof clause === "string") return [clause];
    if (typeof clause === "object" && clause !== null) {
        const value = (clause as { in?: string[] }).in;
        if (Array.isArray(value)) return value;
    }
    return null;
}

function kept<T extends Record<string, unknown>>(rows: T[], where: Record<string, unknown>): T[] {
    return rows.filter((row) =>
        Object.entries(where).every(([field, clause]) => {
            const wanted = listed(clause);
            return wanted === null || wanted.includes(String(row[field]));
        })
    );
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                kept(channels, where),
            findUnique: async ({ where }: { where: { id: string } }) =>
                channels.find((row) => row.id === where.id) ?? null
        },
        chatChannelMember: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                kept(memberships, where)
        },
        chatSpacePreference: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                kept(preferences, where)
        }
    }
}));

const { mentionsReader, notifyLevels, silencedIn } = await import("@/lib/chat/notify");

beforeEach(() => {
    channels = [];
    memberships = [];
    preferences = [];
});

describe("the three answers", () => {
    it("offers a channel one more than a space: following the server", () => {
        expect([...CHAT_NOTIFY_LEVELS]).toEqual(["all", "mentions", "none"]);
        expect([...CHAT_CHANNEL_NOTIFY_LEVELS]).toEqual([
            CHAT_NOTIFY_INHERIT,
            "all",
            "mentions",
            "none"
        ]);
    });

    it("names every one of them", () => {
        for (const level of CHAT_CHANNEL_NOTIFY_LEVELS) {
            expect(CHAT_NOTIFY_LABEL[level]).toBeTruthy();
        }
    });

    it("refuses a word nobody was offered, and refuses inherit for a space", () => {
        const channelId = "0193b0f0-0000-7000-8000-000000000001";
        const spaceId = "0193b0f0-0000-7000-8000-000000000002";
        expect(chatChannelNotifySchema.safeParse({ channelId, level: "inherit" }).success).toBe(
            true
        );
        expect(chatChannelNotifySchema.safeParse({ channelId, level: "quiet" }).success).toBe(
            false
        );
        // A space is where the answer comes from; there is nothing above it.
        expect(chatSpaceNotifySchema.safeParse({ spaceId, level: "inherit" }).success).toBe(false);
        expect(chatSpaceNotifySchema.safeParse({ spaceId, level: "mentions" }).success).toBe(true);
    });
});

describe("which answer is in force", () => {
    it("takes the channel's where it has one", () => {
        expect(resolveChatNotify("mentions", "all")).toBe("mentions");
        expect(resolveChatNotify("all", "none")).toBe("all");
    });

    it("falls through to the space where the channel follows it", () => {
        expect(resolveChatNotify(CHAT_NOTIFY_INHERIT, "mentions")).toBe("mentions");
        expect(resolveChatNotify(null, "none")).toBe("none");
    });

    it("lands on all where there is nothing to inherit", () => {
        // A group and a direct message belong to no space at all.
        expect(resolveChatNotify(CHAT_NOTIFY_INHERIT, null)).toBe("all");
        expect(resolveChatNotify(undefined, undefined)).toBe("all");
    });

    it("treats a word it does not know as no answer at all", () => {
        // Both columns are free text, so a row can hold something no version of
        // this ever wrote - and the safe reading of one is "nobody chose".
        expect(isChatNotifyLevel("loud")).toBe(false);
        expect(resolveChatNotify("loud", "mentions")).toBe("mentions");
        expect(resolveChatNotify("loud", "loud")).toBe("all");
    });
});

describe("resolving a reader's whole rail", () => {
    it("reads the space where the channel defers and the channel where it does not", async () => {
        channels = [
            { id: "general", spaceId: "work" },
            { id: "alerts", spaceId: "work" },
            { id: "group", spaceId: null }
        ];
        memberships = [
            { channelId: "general", userId: "ada", notifyLevel: CHAT_NOTIFY_INHERIT },
            { channelId: "alerts", userId: "ada", notifyLevel: "all" }
        ];
        preferences = [{ spaceId: "work", userId: "ada", notifyLevel: "mentions" }];

        const levels = await notifyLevels("ada", ["general", "alerts", "group"]);
        expect(levels.get("general")).toBe("mentions");
        // The channel overrules the space it is in, in both directions.
        expect(levels.get("alerts")).toBe("all");
        // No space, no membership row, nobody has chosen anything.
        expect(levels.get("group")).toBe("all");
    });
});

describe("who a room's mention does not reach", () => {
    it("skips only the people who asked for nothing", async () => {
        channels = [{ id: "general", spaceId: "work" }];
        memberships = [{ channelId: "general", userId: "ada", notifyLevel: "none" }];
        preferences = [{ spaceId: "work", userId: "grace", notifyLevel: "mentions" }];

        const silenced = await silencedIn("general", ["ada", "grace", "linus"]);
        expect(silenced.has("ada")).toBe(true);
        // Mentions is not silence: a message naming the room is the mention.
        expect(silenced.has("grace")).toBe(false);
        expect(silenced.has("linus")).toBe(false);
    });

    it("carries a space's silence into its channels", async () => {
        channels = [{ id: "general", spaceId: "work" }];
        preferences = [{ spaceId: "work", userId: "ada", notifyLevel: "none" }];

        expect([...(await silencedIn("general", ["ada"]))]).toEqual(["ada"]);
    });
});

describe("what counts as a mention", () => {
    const ada = "0193b0f0-0000-7000-8000-00000000ada0";

    it("counts their own name", () => {
        expect(mentionsReader(`Ping [Ada](polaris:user/${ada}) please`, ada)).toBe(true);
        expect(mentionsReader("Ping [Grace](polaris:user/grace-id) please", ada)).toBe(false);
    });

    it("counts the room, because addressing the room addresses them", () => {
        expect(mentionsReader("@everyone standup in five", ada)).toBe(true);
        expect(mentionsReader("@here quick question", ada)).toBe(true);
    });

    it("does not count one inside a code fence", () => {
        // Which is exactly where somebody puts one to show it to a colleague
        // without waking the room.
        expect(mentionsReader("```\n@everyone\n```", ada)).toBe(false);
    });

    it("counts nothing in an ordinary message", () => {
        expect(mentionsReader("deployed, looks fine", ada)).toBe(false);
    });
});
