/**
 * The database tools, called the way an MCP client calls them.
 *
 * What is pinned is the boundary each one keeps. Every database is opened
 * through the Databases app's own resolver (`addressOf`), which is what decides
 * whether this account may open it at all; a connected app reaches only the
 * databases its person let it, and is told nothing about the others; a query
 * runs on an address forced read-only, so the engine's own read-only
 * transaction refuses a write, whatever the statement looks like; a write needs
 * its own scope and still honours the connection's read-only switch. No
 * address, login or password ever reaches the model.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    actingUser: vi.fn(),
    recordAudit: vi.fn(),
    listOpenable: vi.fn(),
    addressOf: vi.fn(),
    browseAt: vi.fn(),
    runAt: vi.fn(),
    withDriver: vi.fn(),
    columns: vi.fn(),
    relations: vi.fn()
}));

class DataConnectionError extends Error {}
class DataRequestError extends Error {}
class ReadOnlyError extends Error {}

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/mcp/acting-user", () => ({ actingUser: mocks.actingUser }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: mocks.recordAudit }));
vi.mock("@/lib/data/connections", () => ({
    listOpenable: mocks.listOpenable,
    addressOf: mocks.addressOf,
    DataConnectionError
}));
vi.mock("@/lib/data/browser", () => ({ browseAt: mocks.browseAt, runAt: mocks.runAt }));
vi.mock("@/lib/data/open", () => ({ withDriver: mocks.withDriver }));
vi.mock("@/lib/data/driver", () => ({ DataRequestError, ReadOnlyError }));

const { DATABASE_SEARCH, DATABASE_TOOLS, statementFailure } = await import(
    "@/lib/mcp/tools/databases"
);
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const SHOP = "0190a5b8-0000-7000-8000-00000000c0de";
const LOGS = "0190a5b8-0000-7000-8000-0000000010f5";
const MANAGED = "managed:0190a5b8-0000-7000-8000-0000000abcde";

const ADDRESS = {
    engine: "postgres",
    host: "db.internal.example.test",
    port: 5432,
    database: "shop",
    username: "shop_owner",
    password: "s3cret-password",
    tls: { mode: "disable" },
    readOnly: false,
    tunnel: null
};

type ToolResult = {
    content: { type: string; text: string }[];
    isError?: boolean;
    structuredContent?: any;
};

async function call(
    name: string,
    args: Record<string, unknown>,
    scopes: string[] = ["databases.read"],
    databaseIds?: string[] | null
) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        DATABASE_TOOLS,
        {
            userId: "user-1",
            isAdmin: false,
            scopes: scopes as never,
            grantId: "grant-1",
            ...(databaseIds === undefined ? {} : { databaseIds })
        },
        SERVER
    );
    if (reply?.error)
        return { content: [{ type: "text", text: reply.error.message }], isError: true };
    return reply?.result as ToolResult;
}

function connection(id: string, name: string, extra: Record<string, unknown> = {}) {
    return {
        id,
        name,
        engine: "postgres",
        origin: "saved",
        managedDatabaseId: null,
        where: "db.internal.example.test:5432",
        database: "shop",
        username: "shop_owner",
        readOnly: false,
        hasPassword: true,
        tls: { mode: "disable" },
        host: "db.internal.example.test",
        port: 5432,
        tunnel: null,
        note: null,
        unreachable: false,
        lastUsedAt: null,
        createdAt: null,
        ...extra
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.actingUser.mockResolvedValue({ id: "user-1", name: "Ada", isAdmin: false });
    mocks.listOpenable.mockResolvedValue([
        connection(SHOP, "Shop"),
        connection(LOGS, "Logs", { readOnly: true }),
        connection(MANAGED, "Orders", {
            origin: "managed",
            where: "Store / production",
            host: null,
            port: null,
            username: null
        })
    ]);
    mocks.addressOf.mockResolvedValue(ADDRESS);
    mocks.runAt.mockResolvedValue([
        {
            statement: "select id, email from customers",
            columns: ["id", "email"],
            rows: [
                [1, "a@example.test"],
                [2, "b@example.test"]
            ],
            affected: null,
            ms: 3
        }
    ]);
    mocks.withDriver.mockImplementation(async (_address: unknown, use: (driver: any) => unknown) =>
        use({ relations: mocks.relations, columns: mocks.columns })
    );
});

describe("databases_list", () => {
    it("lists what the account can open, with no address, login or password", async () => {
        const result = await call("databases_list", {});
        expect(mocks.listOpenable).toHaveBeenCalledWith("user-1");
        expect(result.structuredContent.databases.map((row: { id: string }) => row.id)).toEqual([
            SHOP,
            LOGS,
            MANAGED
        ]);
        const text = JSON.stringify(result);
        expect(text).not.toContain("db.internal.example.test");
        expect(text).not.toContain("shop_owner");
        expect(text).toContain("Store / production");
    });

    it("lists only the databases a connected app was allowed", async () => {
        const result = await call("databases_list", {}, ["databases.read"], [LOGS]);
        expect(result.structuredContent.databases.map((row: { id: string }) => row.id)).toEqual([
            LOGS
        ]);
    });

    it("filters by a few words", async () => {
        const result = await call("databases_list", { query: "ord" });
        expect(result.structuredContent.databases.map((row: { id: string }) => row.id)).toEqual([
            MANAGED
        ]);
    });

    it("needs the read scope", async () => {
        const result = await call("databases_list", {}, ["deploy.read"]);
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("databases.read");
    });
});

describe("the allow-list", () => {
    it("refuses a database the app was not allowed, before resolving any address", async () => {
        for (const [name, args, scopes] of [
            ["databases_schema", { databaseId: SHOP }, ["databases.read"]],
            ["databases_query", { databaseId: SHOP, statement: "select 1" }, ["databases.read"]],
            [
                "databases_execute",
                { databaseId: SHOP, statement: "delete from carts" },
                ["databases.read", "databases.write"]
            ]
        ] as const) {
            const result = await call(name, args, [...scopes], [LOGS]);
            expect(result.isError, name).toBe(true);
            expect(result.content[0]?.text, name).toContain("not allowed to reach");
        }
        expect(mocks.addressOf).not.toHaveBeenCalled();
        expect(mocks.runAt).not.toHaveBeenCalled();
    });

    it("lets every database through when the grant holds no list", async () => {
        const result = await call("databases_query", { databaseId: SHOP, statement: "select 1" });
        expect(result.isError).toBeUndefined();
        expect(mocks.addressOf).toHaveBeenCalledWith("user-1", SHOP);
    });
});

describe("databases_schema", () => {
    it("lists schemas and tables through the browser's own read, on a read-only address", async () => {
        mocks.browseAt.mockResolvedValue({
            shape: "sql",
            namespaces: [{ name: "public", kind: "schema", count: 2 }],
            relations: [
                { name: "customers", namespace: "public", kind: "table", rows: 2 },
                { name: "orders", namespace: "public", kind: "table", rows: 9 }
            ],
            namespace: "public"
        });
        const result = await call("databases_schema", { databaseId: SHOP });
        expect(mocks.browseAt).toHaveBeenCalledWith({ ...ADDRESS, readOnly: true }, null);
        expect(result.structuredContent).toMatchObject({
            namespace: "public",
            relations: [{ name: "customers" }, { name: "orders" }]
        });
    });

    it("reads one table's columns, and only a table the database holds", async () => {
        mocks.relations.mockResolvedValue([{ name: "customers", kind: "table" }]);
        mocks.columns.mockResolvedValue([
            { name: "id", type: "integer", nullable: false, primaryKey: true }
        ]);
        const result = await call("databases_schema", {
            databaseId: SHOP,
            namespace: "public",
            relation: "customers"
        });
        expect(mocks.withDriver.mock.calls[0]![0]).toMatchObject({ readOnly: true });
        expect(mocks.columns).toHaveBeenCalledWith("public", "customers");
        expect(result.structuredContent.columns).toEqual([
            { name: "id", type: "integer", nullable: false, primaryKey: true }
        ]);

        const missing = await call("databases_schema", {
            databaseId: SHOP,
            namespace: "public",
            relation: "nope"
        });
        expect(missing.isError).toBe(true);
        expect(mocks.columns).toHaveBeenCalledTimes(1);
    });
});

describe("databases_query", () => {
    it("runs on an address forced read-only, whatever the connection says", async () => {
        const result = await call("databases_query", {
            databaseId: SHOP,
            statement: "select id, email from customers"
        });
        expect(mocks.runAt).toHaveBeenCalledWith(
            { ...ADDRESS, readOnly: true },
            "select id, email from customers"
        );
        expect(result.structuredContent.results[0]).toMatchObject({
            columns: ["id", "email"],
            rows: [
                [1, "a@example.test"],
                [2, "b@example.test"]
            ]
        });
        expect(JSON.stringify(result)).not.toContain("s3cret-password");
    });

    it("tells the model to use the write tool when the engine refuses a write", async () => {
        mocks.runAt.mockRejectedValue(new ReadOnlyError("This connection is read-only"));
        const result = await call("databases_query", {
            databaseId: SHOP,
            statement: "with gone as (delete from carts returning 1) select * from gone"
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("databases_execute");
    });

    it("caps the rows it returns and says so", async () => {
        mocks.runAt.mockResolvedValue([
            {
                statement: "select n",
                columns: ["n"],
                rows: Array.from({ length: 300 }, (_, index) => [index]),
                affected: null,
                ms: 1
            }
        ]);
        const result = await call("databases_query", {
            databaseId: SHOP,
            statement: "select n",
            maxRows: 50
        });
        expect(result.structuredContent.results[0].rows).toHaveLength(50);
        expect(result.structuredContent.results[0].truncated).toBe(true);
        expect(result.content[0]?.text).toContain("first 50");
    });

    it("shortens a very long value and describes binary data instead of sending it", async () => {
        mocks.runAt.mockResolvedValue([
            {
                statement: "select body, blob",
                columns: ["body", "blob"],
                rows: [["x".repeat(5000), Buffer.alloc(64)]],
                affected: null,
                ms: 1
            }
        ]);
        const result = await call("databases_query", { databaseId: SHOP, statement: "select" });
        const [body, blob] = result.structuredContent.results[0].rows[0];
        expect(body.length).toBeLessThan(2100);
        expect(blob).toBe("(64 bytes)");
    });

    it("passes on what the engine said about a statement, and nothing about the connection", async () => {
        mocks.runAt.mockRejectedValue(
            Object.assign(new Error('relation "custmers" does not exist'), { code: "42P01" })
        );
        const syntax = await call("databases_query", { databaseId: SHOP, statement: "select" });
        expect(syntax.content[0]?.text).toContain('relation "custmers" does not exist');

        mocks.runAt.mockRejectedValue(
            Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), { code: "ECONNREFUSED" })
        );
        const down = await call("databases_query", { databaseId: SHOP, statement: "select" });
        expect(down.isError).toBe(true);
        expect(down.content[0]?.text).not.toContain("10.0.0.4");
    });

    it("passes on the Databases app's own refusals", async () => {
        mocks.addressOf.mockRejectedValue(
            new DataConnectionError("That database is not one you can open.")
        );
        const result = await call("databases_query", { databaseId: SHOP, statement: "select 1" });
        expect(result.content[0]?.text).toBe("That database is not one you can open.");
    });

    it("refuses an empty or oversized statement before opening anything", async () => {
        expect((await call("databases_query", { databaseId: SHOP, statement: " " })).isError).toBe(
            true
        );
        expect(
            (await call("databases_query", { databaseId: SHOP, statement: "x".repeat(70_000) }))
                .isError
        ).toBe(true);
        expect(mocks.addressOf).not.toHaveBeenCalled();
    });
});

describe("databases_execute", () => {
    it("needs the write scope: reading does not open writing", async () => {
        const result = await call("databases_execute", {
            databaseId: SHOP,
            statement: "delete from carts"
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("databases.write");
        expect(mocks.runAt).not.toHaveBeenCalled();
    });

    it("runs on the connection's own address, so its read-only switch still holds, and audits it", async () => {
        mocks.runAt.mockResolvedValue([
            { statement: "delete from carts", columns: [], rows: [], affected: 4, ms: 2 }
        ]);
        const result = await call(
            "databases_execute",
            { databaseId: SHOP, statement: "delete from carts" },
            ["databases.read", "databases.write"]
        );
        expect(mocks.runAt).toHaveBeenCalledWith(ADDRESS, "delete from carts");
        expect(result.content[0]?.text).toContain("4 rows changed");
        expect(mocks.recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "user-1",
                action: "databases.statement.run",
                targetId: SHOP
            })
        );
        expect(JSON.stringify(mocks.recordAudit.mock.calls)).not.toContain("delete from carts");
    });

    it("is advertised as destructive, and the reads as read-only", () => {
        const byName = new Map(DATABASE_TOOLS.map((tool) => [tool.name, tool]));
        expect(byName.get("databases_execute")?.readOnly).toBe(false);
        expect(byName.get("databases_execute")?.scope).toBe("databases.write");
        for (const name of ["databases_list", "databases_schema", "databases_query"]) {
            expect(byName.get(name)?.readOnly, name).toBe(true);
            expect(byName.get(name)?.scope, name).toBe("databases.read");
        }
    });
});

describe("statementFailure", () => {
    it("passes a statement's own error and keeps a connection's to the log", () => {
        expect(statementFailure(Object.assign(new Error("syntax error"), { code: "42601" }))).toBe(
            "syntax error"
        );
        expect(
            statementFailure(
                Object.assign(new Error("bad"), {
                    sqlState: "42S02",
                    sqlMessage: "Table 'x' doesn't exist"
                })
            )
        ).toBe("Table 'x' doesn't exist");
        expect(
            statementFailure(
                Object.assign(new Error("password authentication failed"), { code: "28P01" })
            )
        ).toBeNull();
        expect(
            statementFailure(Object.assign(new Error("no route"), { code: "08006" }))
        ).toBeNull();
        expect(statementFailure(new Error("socket hang up"))).toBeNull();
    });
});

describe("the search provider", () => {
    const caller = (databaseIds?: string[] | null) => ({
        userId: "user-1",
        isAdmin: false,
        scopes: ["databases.read"] as never,
        ...(databaseIds === undefined ? {} : { databaseIds })
    });

    it("finds the databases this connection reaches, with the tools to call next", async () => {
        const hits = await DATABASE_SEARCH.search("shop", caller([SHOP, MANAGED]), 10);
        expect(hits.map((hit) => hit.id)).toEqual([SHOP, MANAGED]);
        expect(hits[0]).toMatchObject({
            name: "Shop",
            kind: "database",
            next: expect.arrayContaining([
                { tool: "databases_schema", args: { databaseId: SHOP } },
                { tool: "databases_query", args: { databaseId: SHOP } }
            ])
        });
        expect(hits[1]?.where).toBe("Store / production");
    });

    it("never says where a saved connection points or how it signs in", async () => {
        const hits = await DATABASE_SEARCH.search("", caller(), 10);
        expect(hits).toHaveLength(3);
        const said = JSON.stringify(hits);
        expect(said).not.toContain("db.internal.example.test");
        expect(said).not.toContain("shop_owner");
    });

    it("is filed under the databases scope and category", () => {
        expect(DATABASE_SEARCH).toMatchObject({ scope: "databases.read", category: "databases" });
    });
});
