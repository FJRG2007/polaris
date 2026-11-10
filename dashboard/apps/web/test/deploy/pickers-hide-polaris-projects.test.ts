/**
 * Pickers outside Deploy offer the reader's own services, never Polaris's.
 *
 * The report: adding an Analytics website listed "Marketplace / Production / Ad
 * blocker DNS server", "Camera relay", the vision worker and the VPN control
 * server - services Polaris installed to run its own apps. Deploy already leaves
 * those projects out; every other picker of projects or services now does too.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ application: [] as unknown[], project: [] as unknown[] }));

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findMany: vi.fn(async (args: unknown) => {
                calls.application.push(args);
                return [];
            })
        },
        project: {
            findMany: vi.fn(async (args: unknown) => {
                calls.project.push(args);
                return [];
            })
        }
    }
}));
vi.mock("@/lib/deploy-service", () => ({ scopedProjectWhere: vi.fn(async () => ({ ownerId: "ada" })) }));
vi.mock("@/lib/deploy/managed-projects", () => ({
    polarisProjectIds: vi.fn(async () => new Set(["marketplace-project", "mail-project"]))
}));

const { readServiceOptions, readTemplateProjectOptions } = await import("@/lib/deploy-target-options");

beforeEach(() => {
    calls.application.length = 0;
    calls.project.length = 0;
});

describe("pickers of the reader's services", () => {
    it("leaves Polaris's projects out of the services a tunnel can point at", async () => {
        await readServiceOptions("ada", { limit: 20 });
        const where = JSON.stringify(calls.application[0]);
        expect(where).toContain('"notIn":["marketplace-project","mail-project"]');
        expect(where).toContain('"ownerId":"ada"');
    });

    it("never offers one of Polaris's projects as a home for a template", async () => {
        await readTemplateProjectOptions("ada", null, { limit: 20 });
        expect(JSON.stringify(calls.project[0])).toContain('"notIn":["marketplace-project","mail-project"]');
    });
});
