/**
 * What every long operation on a managed database relies on: a failure that
 * names its step without echoing a password, a copy into a container that is
 * refused unless all of it arrived, and one operation at a time per database.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }));

vi.mock("@polaris/db", () => ({
    prisma: {
        databaseOperation: {
            findFirst: mocks.findFirst,
            create: mocks.create,
            update: mocks.update
        }
    }
}));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/database-service", () => ({ databaseCredentials: vi.fn() }));

const ops = await import("../../src/lib/database-ops/ops");

/** A runtime whose container answers `wc -c` with `measured`. */
function ports(measured: string) {
    const received: Buffer[] = [];
    return {
        received,
        runIn: vi.fn(async () => ({ code: 0, output: measured })),
        writeFile: vi.fn(async (_container: string, _path: string, body: NodeJS.ReadableStream) => {
            for await (const chunk of body as Readable) received.push(Buffer.from(chunk as Buffer));
        })
    };
}

describe("lastLine", () => {
    it("reports the engine's last line with any password masked", () => {
        expect(ops.lastLine("starting\nERROR: password hunter22 rejected\n\n", ["hunter22"])).toBe(
            "ERROR: password ******** rejected"
        );
    });
});

describe("runStep", () => {
    it("names the step and never the command", async () => {
        const runtime = {
            runIn: vi.fn(async () => ({ code: 1, output: "FATAL: role does not exist" }))
        };
        await expect(
            ops.runStep(
                runtime as never,
                "db",
                { argv: ["psql", "-c", "PGPASSWORD=hunter22"], describe: "Loading the copy" },
                ["hunter22"]
            )
        ).rejects.toThrow("Loading the copy failed: FATAL: role does not exist");
    });
});

describe("stageInto", () => {
    it("streams the file in and accepts it when the sizes agree", async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-stage-"));
        const file = join(dir, "dump");
        await writeFile(file, "0123456789");
        const runtime = ports("10\n");
        await ops.stageInto(runtime as never, "db", file, "/tmp/x.dump");
        expect(Buffer.concat(runtime.received).toString()).toBe("0123456789");
    });

    it("refuses a copy that did not arrive whole", async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-stage-"));
        const file = join(dir, "dump");
        await writeFile(file, "0123456789");
        await expect(
            ops.stageInto(ports("4\n") as never, "db", file, "/tmp/x.dump")
        ).rejects.toThrow("4 of 10 bytes");
    });

    it("says so when the server cannot receive files", async () => {
        await expect(
            ops.stageInto({ runIn: vi.fn() } as never, "db", "/nowhere", "/tmp/x")
        ).rejects.toThrow(/cannot receive files/);
    });
});

describe("startOperation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.create.mockResolvedValue({ id: "op-1" });
    });

    it("refuses a second operation while one is running", async () => {
        mocks.findFirst.mockResolvedValue({ kind: "restore", startedAt: new Date() });
        await expect(ops.startOperation("db-1", "copy", "user")).rejects.toThrow(
            "A restore is already running"
        );
        expect(mocks.create).not.toHaveBeenCalled();
    });

    it("treats one left running for six hours as abandoned", async () => {
        mocks.findFirst.mockResolvedValue({
            kind: "restore",
            startedAt: new Date(Date.now() - 7 * 3_600_000)
        });
        await expect(ops.startOperation("db-1", "copy", "user")).resolves.toMatchObject({
            id: "op-1"
        });
    });

    it("records an unexpected failure in general words and a refusal in its own", async () => {
        mocks.findFirst.mockResolvedValue(null);
        const operation = await ops.startOperation("db-1", "upgrade", null);
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await operation.fail(new Error("ECONNREFUSED 10.0.0.5:2375"))).toMatch(
            /did not expect/
        );
        expect(
            await operation.fail(new ops.DatabaseOperationError("Version 18 did not start."))
        ).toBe("Version 18 did not start.");
        log.mockRestore();
    });
});
