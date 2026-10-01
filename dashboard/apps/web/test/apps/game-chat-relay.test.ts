/**
 * A Chat message shown to one player in a Minecraft server's chat.
 *
 * What is pinned: only a player an operator linked to the account, and that the
 * account itself says is theirs (its connected Minecraft name, or a server it
 * owns), and only on a Java server where they are on right now, gets it - nobody
 * else, and no other server; it is a `tellraw` to that one player; the words are sent as written,
 * so nothing in a message can restyle it, add a click action or break out of the
 * command; and one server refusing does not stop the next.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ANA = "22222222-2222-4222-8222-222222222222";

const fake = vi.hoisted(() => ({
    links: [] as {
        installedAppId: string;
        player: string;
        userId: string;
        followSignIns: boolean;
    }[],
    installs: [] as {
        id: string;
        ownerId: string;
        catalogId: string;
        status: string;
        applicationId: string;
    }[],
    sessions: [] as { installedAppId: string; name: string }[],
    connections: [] as { userId: string; label: string }[],
    joinLog: "",
    signedInFrom: {} as Record<string, string[]>,
    said: [] as { installedAppId: string; line: string }[],
    /** The servers that already show a channel to everybody playing. */
    showing: new Set<string>(),
    failing: new Set<string>()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        gamePlayerLink: {
            findMany: async ({ where }: { where: { userId: string } }) =>
                fake.links.filter((link) => link.userId === where.userId)
        },
        installedApp: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                fake.installs.filter(
                    (install) => where.id.in.includes(install.id) && install.status !== "removed"
                )
        },
        userConnection: {
            findMany: async ({ where }: { where: { userId: string; provider: string } }) =>
                where.provider === "minecraft"
                    ? fake.connections.filter((connection) => connection.userId === where.userId)
                    : []
        },
        gamePlayerSession: {
            findMany: async ({ where }: { where: { installedAppId: { in: string[] } } }) =>
                fake.sessions.filter((visit) =>
                    where.installedAppId.in.includes(visit.installedAppId)
                )
        }
    }
}));
vi.mock("@polaris-app/game-servers/src/lib/game-sign-in-addresses", () => ({
    signInAddresses: async (userIds: string[]) =>
        new Map(userIds.map((user) => [user, fake.signedInFrom[user] ?? []]))
}));
vi.mock("@/lib/deploy-service", () => ({ readAppRuntimeLog: async () => fake.joinLog }));
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId === "minecraft-bedrock" ? "bedrock" : "java"),
    readPlayerLog: async () => fake.joinLog,
    withServerContainer: async (
        _owner: string,
        installedAppId: string,
        work: (server: unknown) => unknown
    ) => {
        if (fake.failing.has(installedAppId)) throw new Error("the server is not answering");
        return work({
            running: true,
            say: async (argv: string[]) => {
                fake.said.push({ installedAppId, line: argv[0] ?? "" });
                return "";
            }
        });
    }
}));

vi.mock("@polaris-app/game-servers/src/lib/minecraft/chat-link-service", () => ({
    serversShowing: async () => fake.showing
}));

const relay = await import("@polaris-app/game-servers/src/lib/minecraft/chat-relay");

const MESSAGE = {
    userId: ANA,
    author: "Carla",
    conversation: "Carla",
    inChannel: false,
    text: "see you at spawn"
};

beforeEach(() => {
    fake.links = [
        { installedAppId: "survival", player: "ana_mc", userId: ANA, followSignIns: false },
        { installedAppId: "creative", player: "ana_mc", userId: ANA, followSignIns: false },
        { installedAppId: "bedrock", player: "ana_mc", userId: ANA, followSignIns: false },
        {
            installedAppId: "survival",
            player: "ben_mc",
            userId: "someone-else",
            followSignIns: false
        }
    ];
    fake.installs = [
        {
            id: "survival",
            ownerId: "o1",
            catalogId: "minecraft",
            status: "running",
            applicationId: "a1"
        },
        {
            id: "creative",
            ownerId: "o1",
            catalogId: "minecraft",
            status: "running",
            applicationId: "a2"
        },
        {
            id: "bedrock",
            ownerId: "o1",
            catalogId: "minecraft-bedrock",
            status: "running",
            applicationId: "a3"
        }
    ];
    fake.sessions = [
        { installedAppId: "survival", name: "Ana_MC" },
        { installedAppId: "survival", name: "ben_mc" },
        { installedAppId: "bedrock", name: "ana_mc" }
    ];
    fake.connections = [{ userId: ANA, label: "Ana_MC" }];
    fake.joinLog =
        "[12:00:00] [Server thread/INFO]: Ana_MC[/203.0.113.7:51234] logged in with entity id 1";
    fake.signedInFrom = { [ANA]: ["203.0.113.7"] };
    fake.said = [];
    fake.showing = new Set();
    fake.failing = new Set();
});

describe("the line a player is shown", () => {
    it("is a tellraw to that one player, the words as plain text", () => {
        const line = relay.relayCommand("Ana_MC", MESSAGE);
        expect(line?.startsWith("tellraw Ana_MC [")).toBe(true);
        const runs = JSON.parse(line!.slice("tellraw Ana_MC ".length)) as { text: string }[];
        expect(runs.map((run) => run.text).join("")).toBe(
            `${relay.MESSAGE_MARK} [Polaris] Carla: see you at spawn`
        );
    });

    it("marks the line as a message, apart from the server's own [Polaris] lines", () => {
        const line = relay.relayCommand("Ana_MC", MESSAGE);
        const runs = JSON.parse(line!.slice("tellraw Ana_MC ".length)) as {
            text: string;
            color?: string;
        }[];
        expect(relay.MESSAGE_MARK).toBe("✉");
        expect(runs[1]).toEqual({ text: "✉ ", color: "aqua" });
    });

    /** The words of a line, after the author, as one string. */
    function said(message: Parameters<typeof relay.relayCommand>[1]): string {
        const line = relay.relayCommand("Ana_MC", message)!;
        const runs = JSON.parse(line.slice("tellraw Ana_MC ".length)) as { text: string }[];
        const text = runs.map((run) => run.text).join("");
        return text.slice(text.indexOf(": ") + 2);
    }

    it("shows what a message carries beside its words, and alone when there are none", () => {
        expect(said({ ...MESSAGE, text: "look", files: "Photo" })).toBe("look [Photo]");
        expect(said({ ...MESSAGE, text: "", files: "Voice message" })).toBe("[Voice message]");
        expect(said({ ...MESSAGE, text: "", files: "3 files" })).toBe("[3 files]");
        expect(said({ ...MESSAGE, text: "", files: "plan.pdf" })).toBe("[plan.pdf]");
        expect(said({ ...MESSAGE, text: "", files: null })).toBe("Sent a message");
    });

    it("shows a poll with its question and answers, and says when it was forwarded", () => {
        expect(said({ ...MESSAGE, text: "Raid tonight?", poll: ["Yes", "No"] })).toBe(
            "[Poll] Raid tonight? (Yes / No)"
        );
        expect(said({ ...MESSAGE, forwarded: true })).toBe("[Forwarded] see you at spawn");
    });

    it("cuts the words, not the labels, to fit one command", () => {
        const line = relay.relayCommand("Ana_MC", {
            ...MESSAGE,
            text: "word ".repeat(40).trim(),
            files: "x".repeat(200),
            poll: Array.from({ length: 10 }, (_, index) => `${"answer ".repeat(6)}${index}`)
        });
        expect(line).not.toBeNull();
        expect(line).toContain("[Poll]");
        expect(line).toContain("answer");
    });

    it("shortens a poll's answers, then drops the last ones, before dropping the message", () => {
        const line = relay.relayCommand("Ana_MC", {
            ...MESSAGE,
            author: "猫".repeat(48),
            conversation: "犬".repeat(48),
            text: "語".repeat(200),
            files: "画".repeat(48),
            poll: Array.from({ length: 10 }, (_, index) => `${"答".repeat(47)}${index}`)
        });
        expect(line).not.toBeNull();
        expect(Buffer.byteLength(line!, "utf8")).toBeLessThanOrEqual(1014);
        expect(line).toContain("[Poll]");
        expect(line).toContain("画".repeat(48));
    });

    it("names the conversation when it is not the author's own", () => {
        const line = relay.relayCommand("Ana_MC", {
            ...MESSAGE,
            conversation: "builders",
            inChannel: true
        });
        expect(line).toContain('" in #builders"');
    });

    it("cannot be restyled, clicked or broken out of by what is written", () => {
        const hostile =
            '\u00a74red &l bold "},{"text":"x","clickEvent":{"action":"run_command","value":"/op me"}}\nsecond';
        const line = relay.relayCommand("Ana_MC", { ...MESSAGE, text: hostile })!;
        const runs = JSON.parse(line.slice("tellraw Ana_MC ".length)) as Record<string, unknown>[];
        // Still one run for the words, holding them literally, with nothing but text in it.
        const words = runs.at(-1)!;
        expect(Object.keys(words)).toEqual(["text"]);
        expect(words.text).not.toContain("\u00a7");
        expect(words.text).not.toContain("\n");
        expect(words.text).toContain("&l bold");
        expect(runs.some((run) => "clickEvent" in run)).toBe(false);
    });

    it("is not written for a name that cannot be a target", () => {
        expect(relay.relayCommand("@a", MESSAGE)).toBeNull();
        expect(relay.relayCommand("ana mc; op", MESSAGE)).toBeNull();
    });
});

describe("whether an account is ready for it", () => {
    it("is ready once a Java server knows which player it is, playing or not", async () => {
        fake.sessions = [];
        expect(await relay.relayReady(ANA)).toBe(true);
    });

    it("is not ready for a player the account never said is theirs, nor with no link at all", async () => {
        fake.connections = [];
        expect(await relay.relayReady(ANA)).toBe(false);
        expect(await relay.relayReady("33333333-3333-4333-8333-333333333333")).toBe(false);
    });

    it("is ready through a link that follows the account's sign-ins", async () => {
        fake.connections = [];
        fake.links = fake.links.map((link) =>
            link.installedAppId === "survival" && link.userId === ANA
                ? { ...link, followSignIns: true }
                : link
        );
        expect(await relay.relayReady(ANA)).toBe(true);
    });
});

describe("who it is shown to", () => {
    it("is the account's linked player, only where they are on a Java server now", async () => {
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toHaveLength(1);
        expect(fake.said[0]?.installedAppId).toBe("survival");
        expect(fake.said[0]?.line.startsWith("tellraw Ana_MC ")).toBe(true);
    });

    it("is not sent again where the server already shows that channel to everybody", async () => {
        fake.showing = new Set(["survival"]);
        await relay.relayChatToMinecraft({ ...MESSAGE, channelId: "c1" });
        expect(fake.said).toEqual([]);
        // A message from another conversation still reaches them.
        fake.showing = new Set();
        await relay.relayChatToMinecraft({ ...MESSAGE, channelId: "c2" });
        expect(fake.said.map((one) => one.installedAppId)).toEqual(["survival"]);
    });

    it("is nobody for an account that no operator linked", async () => {
        await relay.relayChatToMinecraft({
            ...MESSAGE,
            userId: "33333333-3333-4333-8333-333333333333"
        });
        expect(fake.said).toEqual([]);
    });

    it("is nobody for a player an operator linked to an account that never said the name is theirs", async () => {
        fake.connections = [{ userId: ANA, label: "someone_else" }];
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toEqual([]);
    });

    it("is a player an operator linked to follow the account's sign-ins, with nothing connected", async () => {
        // Offgrid, 2026-09-27: every player linked from the Players list, none of
        // them with a Minecraft name on their account, and only the owner saw
        // anything. A player held to where the account signs in is its holder.
        fake.connections = [];
        fake.links = fake.links.map((link) =>
            link.installedAppId === "survival" && link.userId === ANA
                ? { ...link, followSignIns: true }
                : link
        );
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said.map((one) => one.installedAppId)).toEqual(["survival"]);
    });

    it("is nobody under a sign-ins link who joined from where the account is not signed in", async () => {
        fake.connections = [];
        fake.links = fake.links.map((link) =>
            link.userId === ANA ? { ...link, followSignIns: true } : link
        );
        fake.signedInFrom = { [ANA]: ["198.51.100.4"] };
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toEqual([]);
        fake.signedInFrom = {};
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toEqual([]);
    });

    it("is nobody under a sign-ins link whose join address the log no longer carries", async () => {
        fake.connections = [];
        fake.links = fake.links.map((link) =>
            link.userId === ANA ? { ...link, followSignIns: true } : link
        );
        fake.joinLog = "";
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toEqual([]);
    });

    it("is the linked player on a server the account owns, whatever it connected", async () => {
        fake.connections = [];
        fake.installs = fake.installs.map((install) =>
            install.id === "survival" ? { ...install, ownerId: ANA } : install
        );
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said.map((one) => one.installedAppId)).toEqual(["survival"]);
    });

    it("carries on to the next server when one will not take it", async () => {
        fake.sessions.push({ installedAppId: "creative", name: "ana_mc" });
        fake.failing.add("survival");
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said.map((one) => one.installedAppId)).toEqual(["creative"]);
    });
});
