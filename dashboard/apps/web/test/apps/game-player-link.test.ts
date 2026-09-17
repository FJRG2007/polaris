/**
 * A Minecraft player tied to a Polaris account.
 *
 * Their allowed addresses are the ones that account is signed in from, kept in
 * step on every enforcement pass: signing in somewhere new opens it, signing out
 * closes it and throws them off. Nothing typed for other players is touched, and
 * the address switch being off does not free a linked player.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SERVER = "0190c1d2-0000-7000-8000-0000000000a1";
const OWNER = "0190c1d2-0000-7000-8000-000000000001";
const ADA = "0190c1d2-0000-7000-8000-00000000000a";

type Access = {
    id: string;
    installedAppId: string;
    username: string;
    address: string;
    note: string | null;
    source: string;
    createdAt: Date;
};
type Link = { id: string; installedAppId: string; player: string; userId: string };

let access: Access[] = [];
let links: Link[] = [];
let config: Record<string, unknown> = {};
let signedInFrom: Record<string, string[]> = {};
let online: string[] = [];
let joinLog = "";
const commands: string[][] = [];
let nextId = 0;
const id = () => `row-${(nextId += 1)}`;

function matches(row: Access, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
        if (key === "id" && value && typeof value === "object" && "in" in value) {
            return (value as { in: string[] }).in.includes(row.id);
        }
        return (row as Record<string, unknown>)[key] === value;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({
                id: SERVER,
                applicationId: "app-1",
                catalogId: "minecraft",
                config: JSON.stringify(config)
            })
        },
        user: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === ADA ? { id: ADA } : null,
            findMany: async () => [{ id: ADA, name: "Ada", username: "ada" }]
        },
        gamePlayerAccess: {
            findMany: async ({ where }: { where: Record<string, unknown> }) =>
                access.filter((row) => matches(row, where)),
            findUnique: async ({
                where
            }: {
                where: { installedAppId_username_address: { username: string; address: string } };
            }) =>
                access.find(
                    (row) =>
                        row.username === where.installedAppId_username_address.username &&
                        row.address === where.installedAppId_username_address.address
                ) ?? null,
            count: async ({ where }: { where: Record<string, unknown> }) =>
                access.filter((row) => matches(row, where)).length,
            deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
                access = access.filter((row) => !matches(row, where));
            },
            upsert: async ({
                where,
                create
            }: {
                where: { installedAppId_username_address: { username: string; address: string } };
                create: Omit<Access, "id" | "createdAt" | "note" | "source"> & {
                    note?: string | null;
                    source?: string;
                };
            }) => {
                const key = where.installedAppId_username_address;
                if (
                    access.some(
                        (row) => row.username === key.username && row.address === key.address
                    )
                )
                    return;
                access.push({
                    id: id(),
                    note: null,
                    source: "manual",
                    createdAt: new Date(),
                    ...create
                });
            }
        },
        gamePlayerLink: {
            findMany: async () => links,
            create: async ({ data }: { data: Omit<Link, "id"> }) => {
                links.push({ id: id(), ...data });
            },
            update: async ({ where, data }: { where: { id: string }; data: Partial<Link> }) => {
                links = links.map((link) => (link.id === where.id ? { ...link, ...data } : link));
            },
            delete: async ({ where }: { where: { id: string } }) => {
                links = links.filter((link) => link.id !== where.id);
            }
        }
    }
}));

vi.mock("@/lib/apps/game-sign-in-addresses", () => ({
    signInAddresses: async (userIds: string[]) =>
        new Map(userIds.map((user) => [user, signedInFrom[user] ?? []]))
}));

vi.mock("@/lib/apps/minecraft/service", () => ({
    editionOf: () => "java",
    getServerPlayers: async () => ({
        answering: true,
        players: { online: online.length, max: 20, players: online }
    }),
    runServerCommand: async (_owner: string, _server: string, argv: string[]) => {
        commands.push(argv);
        return "";
    },
    // The whitelist half is the game's own list; this test is about addresses.
    withServerContainer: async () => ""
}));

vi.mock("@/lib/deploy-service", () => ({ readAppRuntimeLog: async () => joinLog }));
vi.mock("@/lib/apps/minecraft/reach", () => ({ noteReachedFrom: async () => false }));
vi.mock("@/lib/apps/install-config", () => ({
    readInstallConfig: (raw: string | null) => (raw ? JSON.parse(raw) : {}),
    patchInstallConfig: async (_id: string, patch: Record<string, unknown>) => {
        config = { ...config, ...patch };
    }
}));
vi.mock("@/lib/apps/container-files", () => ({
    readContainerFile: async () => null,
    readContainerFileState: async () => null,
    writeContainerFile: async () => undefined
}));

const service = await import("@/lib/apps/minecraft/player-access");

function joined(name: string, address: string): string {
    return `[00:41:02 INFO]: ${name}[/${address}:52344] logged in with entity id 214 at (1.5, 64.0, 2.5)`;
}

beforeEach(() => {
    access = [];
    links = [];
    config = {};
    signedInFrom = {};
    online = [];
    joinLog = "";
    commands.length = 0;
});

describe("a linked player's addresses", () => {
    it("follow where the account is signed in, and nothing typed for others", async () => {
        access.push({
            id: id(),
            installedAppId: SERVER,
            username: "Bob",
            address: "5.5.5.5",
            note: null,
            source: "manual",
            createdAt: new Date()
        });
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        expect(access.map((row) => [row.username, row.address, row.source])).toEqual([
            ["Bob", "5.5.5.5", "manual"],
            ["AdaMC", "1.1.1.1", "session"]
        ]);

        signedInFrom[ADA] = ["2.2.2.2"];
        await service.syncLinkedAddresses(SERVER);
        expect(access.filter((row) => row.username === "AdaMC").map((row) => row.address)).toEqual([
            "2.2.2.2"
        ]);
    });

    it("replace any address typed for that name before", async () => {
        await service.grantPlayerAccess(OWNER, SERVER, OWNER, {
            username: "AdaMC",
            address: "any"
        });
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        expect(access.map((row) => row.address)).toEqual(["1.1.1.1"]);
    });

    it("cannot be typed by hand or removed one by one", async () => {
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        await expect(
            service.grantPlayerAccess(OWNER, SERVER, OWNER, {
                username: "adamc",
                address: "9.9.9.9"
            })
        ).rejects.toThrow(/Polaris account/);
        await expect(
            service.revokePlayerAddress(OWNER, SERVER, "AdaMC", "1.1.1.1")
        ).rejects.toThrow(/Unlink/);
    });
});

describe("enforcing a linked player", () => {
    it("throws them off once the account is signed out, with a reason they can act on", async () => {
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        online = ["AdaMC"];
        joinLog = joined("AdaMC", "1.1.1.1");
        expect((await service.enforcePlayerAddresses(OWNER, SERVER)).kicked).toEqual([]);

        signedInFrom[ADA] = [];
        const report = await service.enforcePlayerAddresses(OWNER, SERVER);
        expect(report.kicked).toEqual(["AdaMC"]);
        expect(commands.at(-1)).toEqual(["kick", "AdaMC", service.LINKED_REFUSAL]);
    });

    it("holds them to their sign-ins even with the address check switched off", async () => {
        config = { bindAddresses: false };
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        await service.grantPlayerAccess(OWNER, SERVER, OWNER, {
            username: "Bob",
            address: "5.5.5.5"
        });
        online = ["AdaMC", "Bob"];
        joinLog = [joined("AdaMC", "7.7.7.7"), joined("Bob", "8.8.8.8")].join("\n");
        const report = await service.enforcePlayerAddresses(OWNER, SERVER);
        // Bob is only held to his address when the switch is on; Ada always is.
        expect(report.kicked).toEqual(["AdaMC"]);
    });

    it("comes off the list when unlinked", async () => {
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        await service.unlinkPlayerAccount(OWNER, SERVER, "adamc");
        expect(links).toEqual([]);
        expect(access).toEqual([]);
        expect(commands).toContainEqual([
            "kick",
            "AdaMC",
            "You are no longer on this server's player list."
        ]);
    });
});

describe("the list as the screen reads it", () => {
    it("names the account a linked player follows and marks where each address came from", async () => {
        signedInFrom[ADA] = ["1.1.1.1"];
        await service.linkPlayerAccount(OWNER, SERVER, OWNER, { username: "AdaMC", userId: ADA });
        const view = await service.listPlayerAccess(OWNER, SERVER);
        expect(view.links).toEqual([{ username: "AdaMC", userId: ADA, name: "Ada" }]);
        expect(view.rules.map((rule) => rule.source)).toEqual(["session"]);
    });
});
