/**
 * The Users and Processes tabs' runner: which instances it acts on, that a
 * generated password is returned once and never echoed in an error, and that
 * the accounts Polaris itself signs in with cannot be changed from here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";

const state = vi.hoisted(() => ({
    runIn: vi.fn(async (_container: string, _argv: readonly string[]) => ({ code: 0, output: "" })),
    context: {} as Record<string, unknown>
}));

vi.mock("@/lib/database-ops/ops", async (original) => {
    const real = await original<typeof import("@/lib/database-ops/ops")>();
    return {
        ...real,
        instanceContext: vi.fn(async () => state.context),
        withPorts: vi.fn(async (_context: unknown, work: (ports: unknown) => Promise<unknown>) => work({ runIn: state.runIn }))
    };
});

import * as accounts from "@/lib/database-ops/accounts";

function context(overrides: Record<string, unknown> = {}) {
    return {
        id: DB,
        engine: "postgres",
        container: "polaris-db-shop",
        hosted: false,
        topology: { kind: "single" },
        own: { username: "shop", password: "own-password-0000", database: "shop" },
        admin: { username: "shop", password: "own-password-0000", database: "shop" },
        ...overrides
    };
}

beforeEach(() => {
    state.runIn.mockReset();
    state.runIn.mockResolvedValue({ code: 0, output: "" });
    state.context = context();
});

describe("which instances", () => {
    it("refuses other engines, hosted databases and clusters", async () => {
        state.context = context({ engine: "redis" });
        await expect(accounts.listProcesses(DB, "owner")).rejects.toThrow(/PostgreSQL, MySQL and MariaDB/);
        state.context = context({ hosted: true });
        await expect(accounts.listProcesses(DB, "owner")).rejects.toThrow(/inside another instance/);
        state.context = context({ engine: "mysql", topology: { kind: "replicas", replicas: 1 } });
        await expect(accounts.listProcesses(DB, "owner")).rejects.toThrow(/single instance/);
        expect(state.runIn).not.toHaveBeenCalled();
    });
});

describe("accounts", () => {
    it("lists accounts with Polaris's own protected, and only user databases", async () => {
        state.runIn
            .mockResolvedValueOnce({ code: 0, output: "shop|f|shop\nreporting|f|\n" })
            .mockResolvedValueOnce({ code: 0, output: "postgres\nshop\ntemplate0\ntemplate1\n" });
        const listing = await accounts.listAccounts(DB, "owner");
        expect(listing.accounts).toEqual([
            { username: "shop", databases: ["shop"], protected: true },
            { username: "reporting", databases: [], protected: false }
        ]);
        expect(listing.databases).toEqual(["shop"]);
    });

    it("creates with a generated password, returned once", async () => {
        const created = await accounts.createAccount(DB, "owner", "reporting");
        expect(created.username).toBe("reporting");
        expect(created.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
        expect(state.runIn.mock.calls[0][1].at(-1)).toContain(created.password);
    });

    it("masks passwords in an engine's error", async () => {
        state.runIn.mockImplementation(async (_container, argv) => ({ code: 1, output: `ERROR: near ${argv.at(-1)} own-password-0000` }));
        const error = await accounts.createAccount(DB, "owner", "reporting").catch((caught: Error) => caught);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^Creating the account reporting failed/);
        expect((error as Error).message).not.toContain("own-password-0000");
        expect((error as Error).message).not.toMatch(/PASSWORD '[A-Za-z0-9_-]{32}'/);
    });

    it("never drops or regrants the account Polaris signs in with", async () => {
        await expect(accounts.dropAccount(DB, "owner", "shop")).rejects.toThrow(/cannot be changed here/);
        await expect(accounts.grantAccount(DB, "owner", { username: "shop", database: "shop", privileges: "readonly" })).rejects.toThrow();
        expect(state.runIn).not.toHaveBeenCalled();
    });

    it("grants in the database's own connection after the database-level grant", async () => {
        await accounts.grantAccount(DB, "owner", { username: "reporting", database: "shop", privileges: "readwrite" });
        expect(state.runIn).toHaveBeenCalledTimes(2);
        const second = state.runIn.mock.calls[1][1];
        expect(second[second.indexOf("-d") + 1]).toBe("shop");
    });
});

describe("processes", () => {
    it("lists and kills by id", async () => {
        state.runIn.mockResolvedValueOnce({ code: 0, output: "41|shop|postgres|local|active|0|1|SELECT 1\n" });
        const processes = await accounts.listProcesses(DB, "owner");
        expect(processes[0]).toMatchObject({ id: 41, self: true });
        await accounts.killProcess(DB, "owner", 7);
        expect(state.runIn.mock.calls[1][1].at(-1)).toBe("SELECT pg_terminate_backend(7)");
    });
});
