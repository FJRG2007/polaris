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
    links: [] as { installedAppId: string; player: string; userId: string }[],
    installs: [] as { id: string; ownerId: string; catalogId: string; status: string }[],
    sessions: [] as { installedAppId: string; name: string }[],
    connections: [] as { userId: string; label: string }[],
    said: [] as { installedAppId: string; line: string }[],
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
vi.mock("@polaris-app/game-servers/src/lib/minecraft/service", () => ({
    editionOf: (catalogId: string) => (catalogId === "minecraft-bedrock" ? "bedrock" : "java"),
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
        { installedAppId: "survival", player: "ana_mc", userId: ANA },
        { installedAppId: "creative", player: "ana_mc", userId: ANA },
        { installedAppId: "bedrock", player: "ana_mc", userId: ANA },
        { installedAppId: "survival", player: "ben_mc", userId: "someone-else" }
    ];
    fake.installs = [
        { id: "survival", ownerId: "o1", catalogId: "minecraft", status: "running" },
        { id: "creative", ownerId: "o1", catalogId: "minecraft", status: "running" },
        { id: "bedrock", ownerId: "o1", catalogId: "minecraft-bedrock", status: "running" }
    ];
    fake.sessions = [
        { installedAppId: "survival", name: "Ana_MC" },
        { installedAppId: "survival", name: "ben_mc" },
        { installedAppId: "bedrock", name: "ana_mc" }
    ];
    fake.connections = [{ userId: ANA, label: "Ana_MC" }];
    fake.said = [];
    fake.failing = new Set();
});

describe("the line a player is shown", () => {
    it("is a tellraw to that one player, the words as plain text", () => {
        const line = relay.relayCommand("Ana_MC", MESSAGE);
        expect(line?.startsWith("tellraw Ana_MC [")).toBe(true);
        const runs = JSON.parse(line!.slice("tellraw Ana_MC ".length)) as { text: string }[];
        expect(runs.map((run) => run.text).join("")).toBe("[Polaris] Carla: see you at spawn");
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

describe("who it is shown to", () => {
    it("is the account's linked player, only where they are on a Java server now", async () => {
        await relay.relayChatToMinecraft(MESSAGE);
        expect(fake.said).toHaveLength(1);
        expect(fake.said[0]?.installedAppId).toBe("survival");
        expect(fake.said[0]?.line.startsWith("tellraw Ana_MC ")).toBe(true);
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
