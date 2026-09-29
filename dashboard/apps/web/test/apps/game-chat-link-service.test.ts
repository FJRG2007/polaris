/**
 * What the chat a Minecraft server is linked to does: the badge Chat draws on
 * each linked conversation, the answers to `/online` and `/status` in the linked
 * channel and nowhere else, the channel shown to everybody playing, an
 * announcement repeated there - and the screen that links it, which only takes a
 * conversation the person choosing it may link.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { english } from "../setup/game-english";

const SERVER = "01a09cdd-7a10-7811-833d-8b014c82de01";
const GROUP = "01a09cdd-7a10-7811-833d-8b014c82de02";
const OTHER_GROUP = "01a09cdd-7a10-7811-833d-8b014c82de03";
const SPACE = "01a09cdd-7a10-7811-833d-8b014c82de10";
const VOICE = "01a09cdd-7a10-7811-833d-8b014c82de11";
const TEXT = "01a09cdd-7a10-7811-833d-8b014c82de12";

const fake = vi.hoisted(() => ({
    installs: [] as {
        id: string;
        ownerId: string;
        catalogId: string;
        name: string;
        config: string;
    }[],
    queried: [] as unknown[],
    reading: { running: true, players: null as unknown },
    said: [] as { installedAppId: string; line: string }[],
    notices: [] as { channelId: string; body: string; actorId: string }[],
    patched: [] as Record<string, unknown>[],
    audits: [] as { action: string }[],
    linkable: {
        groups: [] as { id: string; name: string }[],
        spaces: [] as {
            id: string;
            name: string;
            channels: { id: string; name: string; kind: "text" | "voice" }[];
        }[]
    },
    permission: null as string | null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findMany: async (query: unknown) => {
                fake.queried.push(query);
                return fake.installs;
            },
            findUnique: async ({ where }: { where: { id: string } }) =>
                fake.installs.find((install) => install.id === where.id) ?? null
        },
        user: { findUnique: async () => ({ name: "Grace" }) }
    }
}));
vi.mock("@polaris/app-host", () => ({
    host: {
        i18nRequest: { getLocale: async () => "en-US" },
        appsInstallConfig: {
            readInstallConfig: (raw: string | null) => JSON.parse(raw ?? "{}"),
            patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
                fake.patched.push(patch);
            }
        },
        deployService: { readAppRuntimeLog: async () => "" },
        chatLinks: {
            postAppNotice: async (channelId: string, body: string, actorId: string) => {
                fake.notices.push({ channelId, body, actorId });
            },
            linkableConversations: async () => fake.linkable
        },
        auditService: {
            recordAudit: async (entry: { action: string }) => {
                fake.audits.push(entry);
            }
        },
        appsInstallAccess: {
            requireGameServer: async (permission: string) => {
                fake.permission = permission;
                return { user: { id: "ada" }, access: { ownerId: "owner" } };
            }
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId === "minecraft-bedrock" ? "bedrock" : "java"),
    serverReading: async () => fake.reading,
    withServerContainer: async (
        _owner: string,
        installedAppId: string,
        work: (server: unknown) => unknown
    ) =>
        work({
            running: true,
            say: async (lines: string[]) => {
                fake.said.push({ installedAppId, line: lines[0] ?? "" });
            }
        })
}));
vi.mock("@polaris-app/game-servers/src/lib/game-sign-in-addresses", () => ({
    signInAddresses: async () => new Map()
}));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/live-display-service", () => ({
    applySidebar: async () => undefined
}));

const service = await import("@polaris-app/game-servers/src/lib/minecraft/chat-link-service");
const actions = await import("@polaris-app/game-servers/src/screens/installed/chat-link-actions");

function server(config: Record<string, unknown>, catalogId = "minecraft") {
    return {
        id: SERVER,
        ownerId: "owner",
        catalogId,
        name: "Survival",
        config: JSON.stringify(config)
    };
}

const spaceLink = {
    kind: "space" as const,
    spaceId: SPACE,
    callChannelId: VOICE,
    textChannelId: TEXT,
    commands: true,
    announcements: true,
    relay: true
};

function installed(...installs: ReturnType<typeof server>[]): void {
    fake.installs = installs;
    service.forgetLinkedServers();
}

beforeEach(() => {
    installed(server({ chatLink: spaceLink }));
    fake.queried = [];
    fake.reading = { running: true, players: { online: 1, max: 10, players: ["Ada"] } };
    fake.said = [];
    fake.notices = [];
    fake.patched = [];
    fake.audits = [];
    fake.linkable = { groups: [{ id: GROUP, name: "Builders" }], spaces: [] };
    fake.permission = null;
});

describe("the badge on a linked conversation", () => {
    it("marks both rooms of a space, and offers the commands only where they are answered", async () => {
        const links = await service.chatGameLinks([VOICE, TEXT, OTHER_GROUP]);
        expect(links.map((link) => [link.channelId, link.commands.map((one) => one.name)])).toEqual(
            [
                [VOICE, []],
                [TEXT, ["online", "status"]]
            ]
        );
        expect(links[0]).toMatchObject({
            installedAppId: SERVER,
            ownerId: "owner",
            name: "Survival",
            game: "Minecraft",
            logo: "/logos/minecraft.webp"
        });
    });

    it("marks a group chosen for {call.*} before the link existed, without answering in it", async () => {
        installed(server({ callGroupId: GROUP }));
        const links = await service.chatGameLinks([GROUP]);
        expect(links).toHaveLength(1);
        expect(links[0]?.commands).toEqual([]);
    });

    it("reads the servers once for a burst of questions, and again once a link is saved", async () => {
        await service.chatGameLinks([TEXT]);
        await service.answerChatCommand({ channelId: TEXT, command: "online" });
        await service.serversShowing(TEXT);
        expect(fake.queried).toHaveLength(1);
        await actions.saveChatLinkAction({
            installedAppId: SERVER,
            link: { ...spaceLink, commands: false }
        });
        await service.chatGameLinks([TEXT]);
        expect(fake.queried).toHaveLength(2);
    });

    it("asks only about Minecraft servers that have not been removed", async () => {
        await service.chatGameLinks([TEXT]);
        expect(fake.queried[0]).toMatchObject({
            where: {
                catalogId: { in: ["minecraft", "minecraft-bedrock"] },
                status: { not: "removed" }
            }
        });
    });
});

describe("a command in the linked channel", () => {
    it("is answered with who is on", async () => {
        expect(await service.answerChatCommand({ channelId: TEXT, command: "online" })).toEqual([
            "1 of 10 playing on Survival: Ada"
        ]);
    });

    it("is not answered in the voice room, anywhere else, or when commands are off", async () => {
        expect(await service.answerChatCommand({ channelId: VOICE, command: "online" })).toEqual(
            []
        );
        expect(await service.answerChatCommand({ channelId: GROUP, command: "online" })).toEqual(
            []
        );
        expect(await service.answerChatCommand({ channelId: TEXT, command: "op" })).toEqual([]);
        installed(server({ chatLink: { ...spaceLink, commands: false } }));
        expect(await service.answerChatCommand({ channelId: TEXT, command: "status" })).toEqual([]);
    });

    it("says a stopped server is stopped", async () => {
        fake.reading = { running: false, players: null };
        expect(await service.answerChatCommand({ channelId: TEXT, command: "status" })).toEqual([
            "Survival is stopped."
        ]);
    });
});

describe("the channel shown in the game", () => {
    const message = {
        channelId: TEXT,
        authorId: "grace",
        conversation: "general",
        text: "raid at eight",
        files: null,
        poll: null,
        forwarded: false
    };

    it("reaches everybody playing, as a line nothing in it can restyle", async () => {
        await service.relayChannelMessage(message);
        expect(fake.said).toHaveLength(1);
        expect(fake.said[0]?.line.startsWith("tellraw @a [")).toBe(true);
        expect(fake.said[0]?.line).toContain('"text":"raid at eight"');
        expect(fake.said[0]?.line).toContain('"text":" in #general"');
        expect(fake.said[0]?.line).toContain("Grace");
    });

    it("is not shown when the link does not ask for it, or on Bedrock", async () => {
        installed(server({ chatLink: { ...spaceLink, relay: false } }));
        await service.relayChannelMessage(message);
        installed(server({ chatLink: spaceLink }, "minecraft-bedrock"));
        await service.relayChannelMessage(message);
        expect(fake.said).toEqual([]);
        expect([...(await service.serversShowing(TEXT))]).toEqual([]);
    });

    it("is known, so a player's own copy of the message is not sent twice", async () => {
        expect([...(await service.serversShowing(TEXT))]).toEqual([SERVER]);
        expect([...(await service.serversShowing(VOICE))]).toEqual([]);
    });
});

describe("an announcement repeated in the linked channel", () => {
    const announcement = {
        target: "@a",
        title: "Restart soon",
        subtitle: "",
        actionbar: "",
        chat: "",
        tagged: true,
        fadeIn: 0.5,
        stay: 3.5,
        fadeOut: 1,
        sound: "",
        hold: "timed" as const,
        until: ""
    };

    it("is written into the text channel, as the person who sent it", async () => {
        await service.mirrorAnnouncement(
            SERVER,
            "Survival",
            JSON.stringify({ chatLink: spaceLink }),
            announcement,
            {},
            "ada"
        );
        expect(fake.notices).toEqual([
            { channelId: TEXT, body: "Announced on Survival: Restart soon", actorId: "ada" }
        ]);
    });

    it("is not, where the link does not ask for it", async () => {
        await service.mirrorAnnouncement(
            SERVER,
            "Survival",
            JSON.stringify({ chatLink: { ...spaceLink, announcements: false } }),
            announcement,
            {},
            "ada"
        );
        expect(fake.notices).toEqual([]);
    });
});

describe("linking a server", () => {
    const group = {
        kind: "group" as const,
        groupId: GROUP,
        commands: true,
        announcements: false,
        relay: false
    };

    it("is the manager's, and saves one record, clearing the older value", async () => {
        installed(server({ callGroupId: OTHER_GROUP }));
        fake.linkable = { groups: [{ id: GROUP, name: "Builders" }], spaces: [] };
        const result = await actions.saveChatLinkAction({ installedAppId: SERVER, link: group });
        expect(result.error).toBeUndefined();
        expect(fake.permission).toBe("games.manage");
        expect(fake.patched).toEqual([{ chatLink: group, callGroupId: null }]);
        expect(fake.audits.map((one) => one.action)).toEqual(["games.chat.link"]);
    });

    it("refuses a group the person linking it is not in", async () => {
        fake.linkable = { groups: [], spaces: [] };
        const result = await actions.saveChatLinkAction({ installedAppId: SERVER, link: group });
        expect(english(result.error)).toBe("Choose a group you are in");
        expect(fake.patched).toEqual([]);
    });

    it("lets another manager turn its commands on, or a use off, without being in it", async () => {
        installed(server({ chatLink: { ...group, commands: false, relay: true } }));
        fake.linkable = { groups: [], spaces: [] };
        const result = await actions.saveChatLinkAction({
            installedAppId: SERVER,
            link: { ...group, commands: true, relay: false }
        });
        expect(result.error).toBeUndefined();
        expect(fake.patched).toHaveLength(1);
    });

    it("refuses showing it in the game, or writing into it, to somebody not in it", async () => {
        installed(server({ callGroupId: GROUP }));
        fake.linkable = { groups: [], spaces: [] };
        for (const use of [{ relay: true }, { announcements: true }]) {
            const result = await actions.saveChatLinkAction({
                installedAppId: SERVER,
                link: { ...group, ...use }
            });
            expect(english(result.error)).toBe("Choose a group you are in");
        }
        expect(fake.patched).toEqual([]);
    });

    it("keeps a use somebody else turned on when a manager outside it saves again", async () => {
        installed(server({ chatLink: { ...group, relay: true } }));
        fake.linkable = { groups: [], spaces: [] };
        const result = await actions.saveChatLinkAction({
            installedAppId: SERVER,
            link: { ...group, relay: true, commands: false }
        });
        expect(result.error).toBeUndefined();
    });

    it("refuses to show a channel on a Bedrock server", async () => {
        installed(server({ callGroupId: GROUP }, "minecraft-bedrock"));
        const result = await actions.saveChatLinkAction({
            installedAppId: SERVER,
            link: { ...group, relay: true }
        });
        expect(result.error).toMatch(/Only a Java server/);
    });

    it("refuses a link that is not whole, before asking anything", async () => {
        const result = await actions.saveChatLinkAction({
            installedAppId: SERVER,
            link: { ...group, groupId: "builders" } as never
        });
        expect(result.error).toBeDefined();
        expect(fake.permission).toBeNull();
    });

    it("unlinks", async () => {
        const result = await actions.saveChatLinkAction({ installedAppId: SERVER, link: null });
        expect(result.error).toBeUndefined();
        expect(fake.patched).toEqual([{ chatLink: null, callGroupId: null }]);
        expect(fake.audits.map((one) => one.action)).toEqual(["games.chat.unlink"]);
    });
});
