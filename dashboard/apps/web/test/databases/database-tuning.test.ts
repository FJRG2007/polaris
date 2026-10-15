/**
 * The Tuning tab's runner: the memory comes from the limit before the
 * container, MariaDB is read but never written, and applying saves the
 * suggestion and restarts the container.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const DB = "0192f1e2-7b5c-7d3e-8f00-00000000000a";

const state = vi.hoisted(() => ({
    runIn: vi.fn(async (_container: string, _argv: readonly string[]) => ({ code: 0, output: "" })),
    container: vi.fn(async () => undefined),
    waitReady: vi.fn(async () => undefined),
    findUnique: vi.fn(async () => ({ memoryLimitMb: null as number | null })),
    context: {} as Record<string, unknown>
}));

vi.mock("@polaris/db", () => ({ prisma: { managedDatabase: { findUnique: state.findUnique } } }));
vi.mock("@/lib/database-ops/ops", async (original) => {
    const real = await original<typeof import("@/lib/database-ops/ops")>();
    return {
        ...real,
        waitReady: state.waitReady,
        instanceContext: vi.fn(async () => state.context),
        withPorts: vi.fn(async (_context: unknown, work: (ports: unknown) => Promise<unknown>) =>
            work({ runIn: state.runIn, container: state.container })
        )
    };
});

import * as tuning from "@/lib/database-ops/tuning";

function context(engine: string, version = "16") {
    return {
        id: DB,
        engine,
        version,
        container: "polaris-db-shop",
        hosted: false,
        topology: { kind: "single" },
        own: { username: "shop", password: "pw", database: "shop" },
        admin: { username: "shop", password: "pw", database: "shop" }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    state.findUnique.mockResolvedValue({ memoryLimitMb: null });
    state.runIn.mockResolvedValue({ code: 0, output: "" });
    state.context = context("postgres");
});

describe("tuningView", () => {
    it("sizes for the memory limit when one is set, without asking the container", async () => {
        state.findUnique.mockResolvedValue({ memoryLimitMb: 2048 });
        state.runIn.mockResolvedValueOnce({ code: 0, output: "shared_buffers|128MB\n" });
        const view = await tuning.tuningView(DB, "owner");
        expect(view.ramSource).toBe("limit");
        expect(view.settings.find((entry) => entry.name === "shared_buffers")).toEqual({
            name: "shared_buffers",
            current: "128MB",
            suggested: "512MB"
        });
        expect(state.runIn).toHaveBeenCalledTimes(1);
        expect(view.applyRefusal).toBeNull();
    });

    it("reads /proc/meminfo otherwise, and offers MariaDB no apply", async () => {
        state.context = context("mariadb", "11.4");
        state.runIn.mockResolvedValueOnce({ code: 0, output: "MemTotal: 4194304 kB\n" });
        const view = await tuning.tuningView(DB, "owner");
        expect(view.ramSource).toBe("container");
        expect(view.ramMb).toBe(4096);
        expect(view.applyRefusal).toMatch(/MariaDB/);
        await expect(tuning.applyTuning(DB, "owner")).rejects.toThrow(/MariaDB/);
    });
});

describe("applyTuning", () => {
    it("saves each setting with ALTER SYSTEM, then restarts and waits", async () => {
        state.findUnique.mockResolvedValue({ memoryLimitMb: 1024 });
        await tuning.applyTuning(DB, "owner");
        const statements = state.runIn.mock.calls.map((call) => call[1].at(-1));
        expect(statements).toContain("ALTER SYSTEM SET shared_buffers = '256MB'");
        expect(state.container).toHaveBeenCalledWith("polaris-db-shop", "restart");
        expect(state.waitReady).toHaveBeenCalled();
    });

    it("refuses MySQL before 8", async () => {
        state.context = context("mysql", "5.7");
        await expect(tuning.applyTuning(DB, "owner")).rejects.toThrow(/MySQL 8/);
        expect(state.container).not.toHaveBeenCalled();
    });
});
