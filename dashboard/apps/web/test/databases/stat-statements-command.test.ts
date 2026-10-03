/**
 * The command a PostgreSQL instance starts with: the image's own when nothing is
 * on, the archive settings when it archives, and pg_stat_statements appended -
 * never replacing the archive settings - when its Stats asked for it.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "unused" }) }));
vi.mock("@polaris/storage", () => ({ encryptCredentials: vi.fn(), decryptCredentials: vi.fn() }));
vi.mock("@/lib/deploy/runtime", () => ({ getPorts: vi.fn() }));
vi.mock("@/lib/deploy-service", () => ({
    deployLogPath: vi.fn(),
    enqueueOnTarget: vi.fn(),
    executeDeployment: vi.fn(),
    limitsOf: vi.fn()
}));
vi.mock("@/lib/deploy/service-networks", () => ({ networksForService: vi.fn() }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: vi.fn() }));

const { postgresServerCommand } = await import("@/lib/database-service");
const { pitrServerCommand } = await import("@polaris/core");

describe("the PostgreSQL server command", () => {
    it("is the image's own when nothing is asked of it", () => {
        expect(postgresServerCommand({ pitr: false, statStatements: false })).toBeUndefined();
    });

    it("loads pg_stat_statements on its own, or after the archive settings", () => {
        expect(postgresServerCommand({ pitr: false, statStatements: true })).toEqual([
            "postgres",
            "-c",
            "shared_preload_libraries=pg_stat_statements"
        ]);
        expect(postgresServerCommand({ pitr: true, statStatements: true })).toEqual([
            ...pitrServerCommand(),
            "-c",
            "shared_preload_libraries=pg_stat_statements"
        ]);
        expect(postgresServerCommand({ pitr: true, statStatements: false })).toEqual(
            pitrServerCommand()
        );
    });
});
