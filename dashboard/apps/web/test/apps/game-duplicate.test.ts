/**
 * Duplicating a game server: what the copy is made of, who may make one, and
 * what the name has to be.
 *
 * The part with teeth is what must NOT be shared. Two servers answering to one
 * RCON password, one plugin reporting itself under the other's id, one port
 * published twice, two relays into the same chat - each is a fight between the
 * source and its copy, and each is pinned here.
 */

import { describe, expect, it } from "vitest";
import * as plan from "@polaris-app/game-servers/src/lib/duplicate-plan";

const SOURCE = "0190a0b0-0000-7000-8000-000000000001";
const COPY = "0190a0b0-0000-7000-8000-000000000002";
const word = (base: string, count: number | null) => (count === null ? `${base} copy` : `${base} copy ${count}`);

describe("the copy's name", () => {
    it("is offered as '<name> copy'", () => {
        expect(plan.defaultCopyName("Survival", ["Survival"], word)).toBe("Survival copy");
    });

    it("is numbered when that is taken too, ignoring case and spacing", () => {
        expect(plan.defaultCopyName("Survival", ["Survival", "survival  COPY"], word)).toBe("Survival copy 2");
        expect(plan.defaultCopyName("Survival", ["Survival copy", "Survival copy 2"], word)).toBe("Survival copy 3");
    });

    it("shortens the source's name so the word that says what it is still fits", () => {
        const long = "x".repeat(60);
        const name = plan.defaultCopyName(long, [], word);
        expect(name.length).toBeLessThanOrEqual(plan.SERVER_NAME_MAX);
        expect(name.endsWith(" copy")).toBe(true);
    });

    it("is trimmed and its inner spaces collapsed before it is checked", () => {
        const parsed = plan.duplicateServerSchema.safeParse({ installedAppId: SOURCE, name: "  My   copy " });
        expect(parsed.success && parsed.data.name).toBe("My copy");
    });

    it("refuses an empty name and one past the limit", () => {
        expect(plan.duplicateServerSchema.safeParse({ installedAppId: SOURCE, name: "   " }).success).toBe(false);
        expect(
            plan.duplicateServerSchema.safeParse({ installedAppId: SOURCE, name: "a".repeat(plan.SERVER_NAME_MAX + 1) })
                .success
        ).toBe(false);
        expect(
            plan.duplicateServerSchema.safeParse({ installedAppId: SOURCE, name: "a".repeat(plan.SERVER_NAME_MAX) })
                .success
        ).toBe(true);
    });

    it("refuses a source that is not an id", () => {
        expect(plan.duplicateServerSchema.safeParse({ installedAppId: "../etc", name: "x" }).success).toBe(false);
    });

    it("counts a name as taken the way a person reads it", () => {
        expect(plan.nameTaken(" survival  copy", ["Survival copy"])).toBe(true);
        expect(plan.nameTaken("Survival copies", ["Survival copy"])).toBe(false);
    });
});

describe("who may duplicate", () => {
    it("is the owner or an administrator, who may also create servers", () => {
        expect(plan.duplicatePermission({ canCreate: true, isOwner: true, isAdmin: false })).toEqual({ allowed: true });
        expect(plan.duplicatePermission({ canCreate: true, isOwner: false, isAdmin: true })).toEqual({ allowed: true });
    });

    it("is not somebody only invited to help run it", () => {
        expect(plan.duplicatePermission({ canCreate: true, isOwner: false, isAdmin: false })).toEqual({
            allowed: false,
            reason: "not-owner"
        });
    });

    it("is not an owner who may no longer create servers", () => {
        expect(plan.duplicatePermission({ canCreate: false, isOwner: true, isAdmin: false })).toEqual({
            allowed: false,
            reason: "cannot-create"
        });
    });
});

describe("the copy's config", () => {
    const substitutions = [[SOURCE, COPY]] as const;

    it("keeps every setting, including ones this file has never heard of", () => {
        const copied = plan.copiedConfig(
            { blueprintId: "skyblock", consoleCommands: [{ id: "a", command: "say hi" }], someFutureSetting: 7 },
            substitutions
        );
        expect(copied).toEqual({
            blueprintId: "skyblock",
            consoleCommands: [{ id: "a", command: "say hi" }],
            someFutureSetting: 7
        });
    });

    it("drops the address, the chat relays and what the source has been through", () => {
        const copied = plan.copiedConfig(
            {
                hostname: "survival.mc.example.test",
                portless: true,
                chatLink: { channelId: "c" },
                callGroupId: "g",
                crashLoop: { since: "x" },
                onlineSince: "x",
                pendingRestart: true,
                duplicating: { from: SOURCE },
                schedule: { enabled: true }
            },
            substitutions
        );
        expect(copied).toEqual({ schedule: { enabled: true } });
    });

    it("re-points anything that named the source, at any depth", () => {
        const copied = plan.copiedConfig({ events: [{ target: `server:${SOURCE}` }] }, substitutions);
        expect(JSON.stringify(copied)).not.toContain(SOURCE);
        expect(JSON.stringify(copied)).toContain(`server:${COPY}`);
    });
});

describe("the copy's environment", () => {
    const env: plan.EnvEntry[] = [
        { key: "RCON_PASSWORD", value: "source-secret", isSecret: true },
        { key: "POLARIS_SERVER_ID", value: SOURCE, isSecret: false },
        { key: "POLARIS_SERVER_TOKEN", value: "source-token", isSecret: true },
        { key: "RESOURCE_PACK", value: `https://p.example.test/api/minecraft/sounds/${SOURCE}/TOKEN-A/pack.zip`, isSecret: false },
        { key: "MODRINTH_PROJECTS", value: "lithium,ferrite-core", isSecret: false },
        { key: "GAME_CLIENT_PORT", value: "7777", isSecret: false }
    ];
    let minted = 0;
    const copied = plan.copiedEnv({
        env,
        remint: {
            RCON_PASSWORD: () => `new-${++minted}`,
            POLARIS_SERVER_TOKEN: () => `token-${++minted}`,
            ADMIN_PASSWORD: () => "never-used"
        },
        substitutions: [
            ["TOKEN-A", "TOKEN-B"],
            [SOURCE, COPY]
        ],
        overrides: { GAME_CLIENT_PORT: "7779" }
    });
    const value = (key: string) => copied.find((entry) => entry.key === key)?.value;

    it("mints the credentials the two would otherwise share", () => {
        expect(value("RCON_PASSWORD")).not.toBe("source-secret");
        expect(value("POLARIS_SERVER_TOKEN")).not.toBe("source-token");
        expect(copied.find((entry) => entry.key === "RCON_PASSWORD")?.isSecret).toBe(true);
    });

    it("does not add a credential the source never had", () => {
        expect(value("ADMIN_PASSWORD")).toBeUndefined();
    });

    it("re-points the server id and the id-derived pack link at the copy", () => {
        expect(value("POLARIS_SERVER_ID")).toBe(COPY);
        expect(value("RESOURCE_PACK")).toBe(`https://p.example.test/api/minecraft/sounds/${COPY}/TOKEN-B/pack.zip`);
    });

    it("keeps the mods and plugins exactly, and writes the caller's ports over the source's", () => {
        expect(value("MODRINTH_PROJECTS")).toBe("lithium,ferrite-core");
        expect(value("GAME_CLIENT_PORT")).toBe("7779");
        expect(JSON.stringify(copied)).not.toContain(SOURCE);
    });
});

describe("the copy's ports", () => {
    it("never hands two ports of the same copy the same number", async () => {
        const taken = new Set([25565]);
        const free = async (from: number) => {
            let port = from;
            while (taken.has(port)) port += 1;
            return port;
        };
        const ports = await plan.nextFreePorts(
            [
                { from: 25565, protocol: "tcp" },
                { from: 25565, protocol: "tcp" },
                { from: 19132, protocol: "udp" }
            ],
            free
        );
        expect(ports).toEqual([25566, 25567, 19132]);
    });
});

describe("how far a copy has got", () => {
    it("reads back what was written and refuses what was not", () => {
        const state = plan.readDuplicateState({
            duplicating: {
                from: SOURCE,
                fromName: "Survival",
                stage: "copying",
                copiedBytes: 50,
                totalBytes: 200,
                failure: null,
                sourceWasRunning: true,
                startedAt: "2026-10-11T00:00:00.000Z"
            }
        });
        expect(state?.stage).toBe("copying");
        expect(state?.sourceWasRunning).toBe(true);
        expect(plan.readDuplicateState({ duplicating: null })).toBeNull();
        expect(plan.readDuplicateState({ duplicating: { from: SOURCE, stage: "teleporting" } })).toBeNull();
    });

    it("never says 100 percent before the copy says it is done", () => {
        expect(plan.copyPercent({ copiedBytes: 50, totalBytes: 200 })).toBe(25);
        expect(plan.copyPercent({ copiedBytes: 300, totalBytes: 200 })).toBe(99);
        expect(plan.copyPercent({ copiedBytes: 0, totalBytes: null })).toBeNull();
    });

    it("holds the source only while its files may be read", () => {
        expect(plan.holdsSource("copying")).toBe(true);
        expect(plan.holdsSource("starting")).toBe(false);
        expect(plan.holdsSource("failed")).toBe(false);
    });

    it("turns the copy service's refusals into the failures the list explains", () => {
        expect(plan.failureFor("no-space")).toBe("noSpace");
        expect(plan.failureFor("wrong-volume")).toBe("wrongVolume");
        expect(plan.failureFor("not-mounted")).toBe("notMounted");
        expect(plan.failureFor("anything-else")).toBe("copyFailed");
    });

    it("writes sizes the way a disk-space message reads", () => {
        expect(plan.formatBytes(512)).toBe("512 B");
        expect(plan.formatBytes(1.5 * 1024 ** 3)).toBe("1.5 GB");
        expect(plan.formatBytes(20 * 1024 ** 3)).toBe("20 GB");
    });
});

describe("the copying container", () => {
    it("refuses a copy that would leave the disk with less than a working margin", async () => {
        const { copyFits } = await import("@/lib/apps/install-duplicate");
        const gib = 1024 ** 3;
        expect(copyFits(10 * gib, 20 * gib)).toBe(true);
        expect(copyFits(10 * gib, 10 * gib)).toBe(false);
        expect(copyFits(0, 100)).toBe(false);
    });

    it("runs as one line, checks the space before it writes, and only adds to the copy's volumes", async () => {
        const { copyScript } = await import("@/lib/apps/install-duplicate");
        const script = copyScript(2);
        expect(script).not.toMatch(/[\r\n\t]/);
        expect(script.indexOf("polaris-no-space")).toBeLessThan(script.indexOf("cp -a"));
        expect(script).toContain('cp -a "/polaris-from/$i/." "/polaris-to/$i/"');
        expect(script).not.toMatch(/rm -rf[^;]*polaris-from/);
        expect(script.endsWith("echo polaris-copied")).toBe(true);
    });

    it("reads the sizes the script reported", async () => {
        const { readCopyReport } = await import("@/lib/apps/install-duplicate");
        expect(readCopyReport("polaris-need 0 10 900\npolaris-need 1 6 900\n")).toEqual({
            needBytes: 16 * 1024,
            noSpace: null
        });
        expect(readCopyReport("polaris-need 0 10 5\npolaris-no-space 10 5").noSpace).toEqual({
            needBytes: 10 * 1024,
            freeBytes: 5 * 1024
        });
        expect(readCopyReport("").needBytes).toBeNull();
    });

    it("publishes the copy on its own ports, never the source's", async () => {
        const { copiedSourceConfig } = await import("@/lib/apps/install-duplicate");
        const source = {
            imageRef: "example/game:1",
            port: 25565,
            hostPort: 25565,
            hostProtocol: "tcp",
            extraPorts: [{ host: 19132, container: 19132, protocol: "udp" }]
        };
        expect(copiedSourceConfig(source, { hostPort: 25566 })).toEqual({
            imageRef: "example/game:1",
            port: 25565,
            hostPort: 25566,
            hostProtocol: "tcp"
        });
    });
});
