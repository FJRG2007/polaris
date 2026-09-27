/**
 * The chat a Minecraft server is linked to: one record, read by everything that
 * needs "this server's chat" - and a server set up before it existed keeps the
 * group it had chosen for `{call.*}`.
 */

import { describe, expect, it } from "vitest";
import {
    CALL_GROUP_KEY,
    CHAT_LINK_KEY,
    announcementMirror,
    chatLinkPatch,
    chatLinkSchema,
    groupLink,
    linkRefusal,
    linkedChannelIds,
    linkedChannels,
    onlineAnswer,
    readChatLink,
    sameTarget,
    statusAnswer,
    type ChatLink,
    type Linkable
} from "@polaris-app/game-servers/src/lib/minecraft/chat-link";

const GROUP = "01a09cdd-7a10-7811-833d-8b014c82de02";
const OTHER_GROUP = "01a09cdd-7a10-7811-833d-8b014c82de03";
const SPACE = "01a09cdd-7a10-7811-833d-8b014c82de10";
const VOICE = "01a09cdd-7a10-7811-833d-8b014c82de11";
const TEXT = "01a09cdd-7a10-7811-833d-8b014c82de12";

const spaceLink: ChatLink = {
    kind: "space",
    spaceId: SPACE,
    callChannelId: VOICE,
    textChannelId: TEXT,
    commands: true,
    announcements: true,
    relay: false
};

describe("reading the link", () => {
    it("reads the group chosen for {call.*} before the link existed, as a link to it", () => {
        const link = readChatLink({ [CALL_GROUP_KEY]: GROUP });
        expect(link).toEqual({
            kind: "group",
            groupId: GROUP,
            commands: true,
            announcements: false,
            relay: false
        });
        // The call it fed is the same call.
        expect(linkedChannels(link).call).toBe(GROUP);
    });

    it("prefers the link to the older value", () => {
        expect(readChatLink({ [CHAT_LINK_KEY]: spaceLink, [CALL_GROUP_KEY]: OTHER_GROUP })).toEqual(
            spaceLink
        );
    });

    it("is nothing when neither is there, or the old value is not an id", () => {
        expect(readChatLink({})).toBeNull();
        expect(readChatLink({ [CALL_GROUP_KEY]: "not an id" })).toBeNull();
        expect(readChatLink({ [CALL_GROUP_KEY]: null })).toBeNull();
    });

    it("leaves one record once it is saved: the older value is cleared", () => {
        const saved = { [CALL_GROUP_KEY]: GROUP, ...chatLinkPatch(spaceLink) };
        expect(saved[CALL_GROUP_KEY]).toBeNull();
        expect(readChatLink(saved)).toEqual(spaceLink);
        // Unlinking does not bring the old group back.
        expect(readChatLink({ [CALL_GROUP_KEY]: GROUP, ...chatLinkPatch(null) })).toBeNull();
    });

    it("resolves a group to one conversation, and a space to its two rooms", () => {
        expect(linkedChannels(groupLink(GROUP))).toEqual({ call: GROUP, text: GROUP });
        expect(linkedChannelIds(groupLink(GROUP))).toEqual([GROUP]);
        expect(linkedChannels(spaceLink)).toEqual({ call: VOICE, text: TEXT });
        expect(linkedChannelIds({ ...spaceLink, callChannelId: null })).toEqual([TEXT]);
        expect(linkedChannels(null)).toEqual({ call: null, text: null });
    });

    it("refuses a record that is not whole", () => {
        expect(chatLinkSchema.safeParse({ kind: "group", groupId: GROUP }).success).toBe(false);
        expect(chatLinkSchema.safeParse({ ...spaceLink, textChannelId: "general" }).success).toBe(
            false
        );
        expect(chatLinkSchema.safeParse({ ...spaceLink, kind: "server" }).success).toBe(false);
    });
});

describe("who may link to what", () => {
    const linkable: Linkable = {
        groups: [{ id: GROUP, name: "Builders" }],
        spaces: [
            {
                id: SPACE,
                name: "Offgrid",
                channels: [
                    { id: VOICE, name: "voice", kind: "voice" },
                    { id: TEXT, name: "general", kind: "text" }
                ]
            }
        ]
    };

    it("takes a group they are in, and rooms of the right kind in a space they run", () => {
        expect(linkRefusal(groupLink(GROUP), linkable)).toBeNull();
        expect(linkRefusal(spaceLink, linkable)).toBeNull();
        expect(linkRefusal({ ...spaceLink, callChannelId: null }, linkable)).toBeNull();
    });

    it("refuses a group they are not in, and a space they do not run", () => {
        expect(linkRefusal(groupLink(OTHER_GROUP), linkable)).toBe("Choose a group you are in");
        expect(linkRefusal({ ...spaceLink, spaceId: OTHER_GROUP }, linkable)).toBe(
            "Choose a space you run"
        );
    });

    it("refuses a text room for the call, a voice room for the text, and neither", () => {
        expect(linkRefusal({ ...spaceLink, callChannelId: TEXT }, linkable)).toBe(
            "Choose a voice channel of that space"
        );
        expect(linkRefusal({ ...spaceLink, textChannelId: VOICE }, linkable)).toBe(
            "Choose a text channel of that space"
        );
        expect(
            linkRefusal({ ...spaceLink, callChannelId: null, textChannelId: null }, linkable)
        ).toBe("Choose a voice channel, a text channel, or both");
    });

    it("knows the same conversation whatever it is used for", () => {
        expect(sameTarget(spaceLink, { ...spaceLink, relay: true, commands: false })).toBe(true);
        expect(sameTarget(spaceLink, { ...spaceLink, textChannelId: null })).toBe(false);
        expect(sameTarget(groupLink(GROUP), groupLink(GROUP))).toBe(true);
        expect(sameTarget(groupLink(GROUP), null)).toBe(false);
    });
});

describe("answering /online and /status", () => {
    const up = {
        name: "Survival",
        running: true,
        players: { online: 2, max: 20, players: ["Ada", "Grace"] },
        release: "1.21.1"
    };

    it("names who is on", () => {
        expect(onlineAnswer(up)).toBe("2 of 20 playing on Survival: Ada, Grace");
        expect(onlineAnswer({ ...up, players: { online: 0, max: 20, players: [] } })).toBe(
            "Nobody is playing on Survival (0 of 20)."
        );
    });

    it("says how many more there are past the first twenty", () => {
        const names = Array.from({ length: 23 }, (_, at) => `P${at}`);
        expect(onlineAnswer({ ...up, players: { online: 23, max: 30, players: names } })).toMatch(
            /: P0, P1, .*P19 and 3 more$/
        );
    });

    it("says it is up, how full, and the release it was built on", () => {
        expect(statusAnswer(up)).toBe("Survival is up - 2 of 20 playing, Minecraft 1.21.1.");
        expect(statusAnswer({ ...up, release: "LATEST" })).toBe(
            "Survival is up - 2 of 20 playing."
        );
    });

    it("says it is stopped, or not answering, and nothing about why", () => {
        expect(statusAnswer({ ...up, running: false, players: null })).toBe("Survival is stopped.");
        expect(onlineAnswer({ ...up, running: false, players: null })).toBe(
            "Survival is not running."
        );
        expect(statusAnswer({ ...up, players: null })).toBe(
            "Survival is starting, or not answering right now."
        );
    });

    it("writes a server's name as plain words, not as markup", () => {
        expect(onlineAnswer({ ...up, name: "[Best](https://x.test) *server*" })).toMatch(
            /^2 of 20 playing on Besthttps:\/\/x.test server: /
        );
    });
});

describe("repeating an announcement in the channel", () => {
    const announcement = {
        target: "@a",
        title: "&6Restart {server.name}",
        subtitle: "",
        actionbar: "Hi {player}",
        chat: "Back in 5 minutes, {server.online} online"
    };

    it("fills in the server's values, drops the colours and anything written per player", () => {
        expect(
            announcementMirror("Survival", announcement, {
                "server.name": "Survival",
                "server.online": "3"
            })
        ).toBe("Announced on Survival: Restart Survival - Back in 5 minutes, 3 online");
    });

    it("repeats nothing aimed at one player, or with nothing left to say", () => {
        expect(announcementMirror("Survival", { ...announcement, target: "Ada" }, {})).toBeNull();
        expect(
            announcementMirror("Survival", { ...announcement, title: "", chat: "" }, {})
        ).toBeNull();
    });
});
