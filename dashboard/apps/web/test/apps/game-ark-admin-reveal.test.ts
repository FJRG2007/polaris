/**
 * The admin password a legacy ARK install was given, repaired the first time its
 * owner opens the passwords.
 *
 * Servers created before the create flow minted its own admin password were
 * given the install's 48 hex characters, which ARK's `enablecheats` prompt
 * refuses outright - nobody could administer them from inside the game, and the
 * only way out was to delete the server. Reading the passwords now replaces that
 * value with a fresh, game-accepted one and writes it back, so every one of
 * those servers is repaired the first time anybody looks.
 */

import { vi } from "vitest";
import { beforeEach, describe, expect, it } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const INSTALL = "aaaaaaaa-1111-4111-8111-111111111111";

const fake = vi.hoisted(() => ({
    adminPassword: "",
    joinPassword: "Correct9Horse",
    writes: [] as Array<{ key: string; value: string; isSecret: boolean }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: {
            findFirst: async () => ({ applicationId: "app-1", catalogId: "ark" })
        },
        envVar: {
            findMany: async () => [
                { id: "row-join", key: "SERVER_PASSWORD" },
                { id: "row-admin", key: "ADMIN_PASSWORD" }
            ]
        }
    }
}));

vi.mock("@polaris/app-host", () => {
    // `ark/service.ts` sits beside a dozen sibling modules that each destructure
    // their own corner of `host` at import time (the port registry, the deploy
    // service, the network service...) - none of which this test calls. Rather
    // than naming every one, anything beyond the two functions `revealArkPasswords`
    // actually uses reads as an empty, harmless service.
    const unused = new Proxy({}, { get: () => undefined });
    const envVarService = {
        revealEnvVar: async (id: string) => (id === "row-admin" ? fake.adminPassword : fake.joinPassword),
        setEnvVars: async (
            _scope: string,
            _scopeId: string,
            _owner: string,
            vars: Array<{ key: string; value: string; isSecret: boolean }>
        ) => {
            fake.writes.push(...vars);
            return vars.length;
        }
    };
    const host = new Proxy(
        { envVarService },
        { get: (target, prop) => (prop in target ? (target as Record<string, unknown>)[prop as string] : unused) }
    );
    return { host };
});

const { revealArkPasswords } = await import("@polaris-app/game-servers/src/lib/ark/service");
const { isLegacyAdminPassword } = await import("@polaris-app/game-servers/src/lib/ark/access");

beforeEach(() => {
    fake.writes = [];
});

describe("opening an ARK server's passwords", () => {
    it("leaves a password the owner chose alone", async () => {
        fake.adminPassword = "Correct9Horse";
        const result = await revealArkPasswords(OWNER, INSTALL);
        expect(result).toEqual({
            joinPassword: "Correct9Horse",
            adminPassword: "Correct9Horse",
            adminReplaced: false
        });
        expect(fake.writes).toEqual([]);
    });

    it("mints a fresh, game-accepted one for the install's legacy 48 hex characters, and writes it back", async () => {
        fake.adminPassword = "0123456789abcdef".repeat(3);
        const result = await revealArkPasswords(OWNER, INSTALL);

        expect(result.adminReplaced).toBe(true);
        expect(result.adminPassword).not.toBe(fake.adminPassword);
        expect(result.adminPassword).toBeTruthy();
        expect(isLegacyAdminPassword(result.adminPassword as string)).toBe(false);
        expect(fake.writes).toEqual([{ key: "ADMIN_PASSWORD", value: result.adminPassword, isSecret: true }]);
    });
});
