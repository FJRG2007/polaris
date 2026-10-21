/**
 * The connector store: a name whose tools would share another connector's
 * names is refused, and a tool's answer is written on top of what is stored
 * now, under the row's lock, never from a copy read before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ID = "0190a000-0000-7000-8000-000000000001";

const state = vi.hoisted(() => ({
    rows: [] as Record<string, unknown>[],
    locks: [] as unknown[],
    created: [] as unknown[]
}));

vi.mock("@polaris/config", () => ({
    loadEnv: () => ({ POLARIS_DB_PROVIDER: "postgresql", POLARIS_MASTER_KEY: "key" })
}));
vi.mock("@polaris/storage", () => ({
    CredentialDecryptError: class extends Error {},
    encryptSecret: (plain: string) => ({
        ciphertext: Buffer.from(plain),
        nonce: Buffer.from("n"),
        keyId: "k"
    }),
    decryptSecret: (blob: { ciphertext: Buffer }) => blob.ciphertext.toString()
}));
vi.mock("@/lib/polar/access", () => ({ readPolarPolicy: async () => ({}) }));
vi.mock("@polaris/db", () => {
    const own = (where: { id?: string; ownerId: string }) =>
        state.rows.filter(
            (row) => row.ownerId === where.ownerId && (!where.id || row.id === where.id)
        );
    const polarConnector = {
        findMany: async ({ where }: { where: { ownerId: string } }) => own(where),
        findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
            own(where)[0] ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = {
                id: ID,
                enabled: true,
                tools: [],
                toolPolicies: {},
                status: "new",
                ...data
            };
            state.created.push(row);
            return row;
        },
        update: async ({
            where,
            data
        }: {
            where: { id: string };
            data: Record<string, unknown>;
        }) => {
            const row = state.rows.find((entry) => entry.id === where.id)!;
            Object.assign(row, data);
            return row;
        }
    };
    const prisma = {
        polarConnector,
        $queryRaw: async (...args: unknown[]) => {
            state.locks.push(args);
            return [];
        },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma)
    };
    return { prisma };
});

const store = await import("@/lib/polar/connectors/store");

const POLICY = { who: "everyone" as const, hosts: [], privateNetwork: false };
const tool = (name: string) => ({
    name,
    title: null,
    description: "",
    inputSchema: { type: "object" },
    readOnly: false,
    destructive: true
});

function row(extra: Record<string, unknown> = {}) {
    return {
        id: ID,
        ownerId: OWNER,
        name: "Linear",
        url: "https://mcp.linear.app/mcp",
        transport: "http",
        auth: "none",
        enabled: true,
        tools: [tool("create"), tool("delete")],
        toolPolicies: {},
        status: "ok",
        lastError: null,
        checkedAt: null,
        secret: null,
        secretNonce: null,
        secretKeyId: null,
        ...extra
    };
}

beforeEach(() => {
    state.rows = [];
    state.locks = [];
    state.created = [];
});

describe("createConnector", () => {
    it("refuses a name whose tools would go by another connector's names", async () => {
        state.rows.push(row({ name: "My Server" }));
        const input = {
            name: "my-server!",
            url: "https://mcp.example.com/mcp",
            transport: "http",
            auth: "none"
        } as const;
        expect(await store.createConnector(OWNER, input, POLICY)).toBe("duplicate");
        expect(state.created).toEqual([]);
    });

    it("accepts the same name on somebody else's account", async () => {
        state.rows.push(row({ ownerId: "22222222-2222-4222-8222-222222222222" }));
        const input = {
            name: "Linear",
            url: "https://mcp.example.com/mcp",
            transport: "http",
            auth: "none"
        } as const;
        expect(typeof (await store.createConnector(OWNER, input, POLICY))).toBe("object");
    });
});

describe("setToolPolicy", () => {
    it("adds to the answers stored now, under the row's lock", async () => {
        state.rows.push(row());
        const stale = await store.ownConnector(OWNER, ID);
        state.rows[0]!.toolPolicies = { delete: "block" };
        expect(stale?.row.policies).toEqual({});
        expect(await store.setToolPolicy(OWNER, ID, "create", "allow")).toBe(true);
        expect(state.rows[0]!.toolPolicies).toEqual({ delete: "block", create: "allow" });
        expect(state.locks).toHaveLength(1);
    });

    it("refuses a tool the server never listed, and another person's connector", async () => {
        state.rows.push(row());
        expect(await store.setToolPolicy(OWNER, ID, "drop_everything", "allow")).toBe(false);
        expect(
            await store.setToolPolicy("22222222-2222-4222-8222-222222222222", ID, "create", "allow")
        ).toBe(false);
        expect(state.rows[0]!.toolPolicies).toEqual({});
    });
});

describe("updateSecret", () => {
    it("changes the secret stored now, and refuses an id that is not one", async () => {
        state.rows.push(
            row({
                auth: "bearer",
                secret: Buffer.from(JSON.stringify({ token: "t1" })),
                secretNonce: Buffer.from("n")
            })
        );
        const result = await store.updateSecret(OWNER, ID, (current) => ({
            secret: { ...current, token: `${current?.token}-2` },
            result: "done"
        }));
        expect(result).toBe("done");
        expect((await store.ownConnector(OWNER, ID))?.secret).toEqual({ token: "t1-2" });
        expect(
            await store.updateSecret(OWNER, "not-an-id", () => ({ secret: null, result: 1 }))
        ).toBeNull();
    });
});
