/**
 * A MySQL dump leaves the GTID statements out. The primary of a MySQL with read
 * replicas runs with GTIDs on, where a dump that records them needs a privilege
 * the database's own account lacks, and a copy that carries them cannot be loaded
 * into a primary. MariaDB's tool has no such option and is not given one.
 */

import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
    runIn: vi.fn(async (_container: string, _argv: readonly string[]) => ({ code: 0, output: "" })),
    readFile: vi.fn(async () => Readable.toWeb(Readable.from([Buffer.from("-- dump")])) as ReadableStream<Uint8Array>),
    dispose: vi.fn(async () => undefined)
}));

vi.mock("@polaris/db", () => ({
    prisma: { deployTarget: { findFirst: async () => ({ id: "target-1", kind: "local" }) } },
    Prisma: { dmmf: { datamodel: { models: [] } } }
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: async () => ports }));
vi.mock("@/lib/database-service", () => ({ databaseClusterNodes: vi.fn(), databaseConnection: vi.fn() }));
vi.mock("@/lib/database-ops/restore", () => ({ restoreDumpInto: vi.fn() }));
vi.mock("@/lib/database-ops/ops", () => ({ instanceContext: vi.fn(), startOperation: vi.fn() }));

const { dumpInContainer } = await import("@/lib/backups/sources/databases");

/** The dump command the container was asked to run for `engine`. */
async function dumpScript(engine: "mysql" | "mariadb"): Promise<string> {
    ports.runIn.mockClear();
    const artifact = await dumpInContainer({
        ownerId: "owner",
        targetId: "target-1",
        container: "shop-orders-1a2b",
        engine,
        database: "orders",
        username: "polaris",
        password: "secret",
        label: "orders"
    });
    await artifact.cleanup();
    return ports.runIn.mock.calls[0]?.[1].at(-1) ?? "";
}

describe("dumping a MySQL-family database", () => {
    it("tells mysqldump to leave the GTID statements out", async () => {
        expect(await dumpScript("mysql")).toContain("'mysqldump' '--single-transaction' '--set-gtid-purged=OFF'");
    });

    it("gives mariadb-dump no option it does not have", async () => {
        const script = await dumpScript("mariadb");
        expect(script).toContain("'mariadb-dump' '--single-transaction'");
        expect(script).not.toContain("gtid");
    });
});
