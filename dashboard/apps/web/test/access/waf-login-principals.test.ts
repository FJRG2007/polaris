/**
 * How the scopes of a firewall rule combine into who a require-login route lets in.
 *
 * The direction is the whole point and it is not symmetric: a scope that names who it
 * admits can only narrow what it inherited, and a scope that names who it refuses is
 * obeyed by every scope below it. Getting either backwards would let a service owner
 * hand themselves access an instance-wide rule had taken away, which is a widening
 * nothing in the UI would show.
 */

import { describe, expect, it, vi } from "vitest";

interface Row {
    scopeType: string;
    ipAllowlist: string;
    ipDenylist: string;
    requireLogin: boolean;
    loginAllowPrincipals: string;
    loginDenyPrincipals: string;
    browserIntegrity: boolean;
    sqlInjectionProtection: boolean;
    xssProtection: boolean;
    emailObfuscation: boolean;
    presets: string;
    rules: string;
}

let rows: Row[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findUnique: vi.fn(async () => ({
                environmentId: "env-1",
                environment: { projectId: "project-1" },
                target: { hostId: null }
            }))
        },
        wafRule: { findMany: vi.fn(async () => rows) },
        hostGroupMember: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/setting-store", () => ({ getSetting: vi.fn(async () => null), setSetting: vi.fn(async () => undefined) }));

const { resolveWaf } = await import("@/lib/waf-service");

/** A scope's row, carrying only what this file is about. */
function scope(scopeType: string, login: { admit?: unknown[]; refuse?: unknown[] }): Row {
    return {
        scopeType,
        ipAllowlist: "[]",
        ipDenylist: "[]",
        requireLogin: true,
        loginAllowPrincipals: JSON.stringify(login.admit ?? []),
        loginDenyPrincipals: JSON.stringify(login.refuse ?? []),
        browserIntegrity: false,
        sqlInjectionProtection: true,
        xssProtection: true,
        emailObfuscation: true,
        presets: "[]",
        rules: "[]"
    };
}

describe("who a require-login route admits", () => {
    it("names nobody when no scope does, which is what admits any account", async () => {
        rows = [scope("global", {}), scope("application", {})];
        const waf = await resolveWaf("app-1");
        expect(waf.loginAllowLists).toEqual([]);
        expect(waf.loginDeny).toEqual([]);
    });

    it("keeps one list per scope that named somebody, so they have to be satisfied together", async () => {
        rows = [
            scope("global", { admit: [{ ref: "group:staff" }] }),
            scope("application", { admit: [{ ref: "group:ops" }] })
        ];
        expect((await resolveWaf("app-1")).loginAllowLists).toEqual([
            [{ ref: "group:staff" }],
            [{ ref: "group:ops" }]
        ]);
    });

    it("drops a scope that named nobody rather than letting it become a list nobody satisfies", async () => {
        rows = [scope("global", {}), scope("application", { admit: [{ ref: "group:ops" }] })];
        expect((await resolveWaf("app-1")).loginAllowLists).toEqual([[{ ref: "group:ops" }]]);
    });

    it("gathers every scope's refusals into one list, so a broader one still applies", async () => {
        rows = [
            scope("global", { refuse: [{ ref: "role:contractor" }] }),
            scope("application", { refuse: [{ ref: "user:u1", until: 1_800_000_000 }] })
        ];
        expect((await resolveWaf("app-1")).loginDeny).toEqual([
            { ref: "role:contractor" },
            { ref: "user:u1", until: 1_800_000_000 }
        ]);
    });

    it("drops an entry that no longer parses without taking the rest of its list", async () => {
        // A stored list is validated on read for the same reason the custom rules are:
        // one bad entry must not cost the narrowing an operator actually wrote.
        rows = [scope("application", { admit: [{ ref: "group:ops" }, { ref: "nonsense" }, 7] })];
        expect((await resolveWaf("app-1")).loginAllowLists).toEqual([[{ ref: "group:ops" }]]);
    });
});
