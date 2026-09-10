/**
 * A Deploy action lands in its organization's history.
 *
 * An organization's Activity screen is exactly the audit entries that name it,
 * and almost no Deploy write used to name it - so a project on an organization's
 * shelf could be deployed, reconfigured and handed to strangers without any of it
 * appearing there. The organization is now resolved from what the entry is about,
 * in one place; this pins that resolution for each kind of thing a Deploy entry
 * can be about, and that an explicit id - the only way a deletion can say whose
 * it was - wins.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const recorded: { orgId?: string; action: string }[] = [];

vi.mock("@polaris/db", () => ({
    prisma: {
        project: { findUnique: async () => ({ orgId: "org-p" }) },
        environment: { findUnique: async () => ({ project: { orgId: "org-e" } }) },
        application: { findUnique: async () => ({ environment: { project: { orgId: "org-a" } } }) },
        managedDatabase: {
            findUnique: async () => ({ environment: { project: { orgId: "org-d" } } })
        },
        domain: { findUnique: async () => ({ applicationId: "app-1" }) },
        volume: { findUnique: async () => ({ applicationId: null }) },
        deployment: {
            findUnique: async () => ({ deployableType: "database", deployableId: "db-1" })
        }
    }
}));

vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { orgId?: string; action: string }) => {
        recorded.push({ orgId: event.orgId, action: event.action });
    }
}));

const { deployTargetOrgId, recordDeployAudit } = await import("@/lib/deploy-audit");

beforeEach(() => {
    recorded.length = 0;
});

describe("whose history a Deploy entry belongs to", () => {
    it("follows each kind of target to its project's organization", async () => {
        expect(await deployTargetOrgId("project", "p")).toBe("org-p");
        expect(await deployTargetOrgId("environment", "e")).toBe("org-e");
        expect(await deployTargetOrgId("application", "a")).toBe("org-a");
        expect(await deployTargetOrgId("database", "d")).toBe("org-d");
        expect(await deployTargetOrgId("domain", "x")).toBe("org-a");
        expect(await deployTargetOrgId("deployment", "x")).toBe("org-d");
    });

    it("names no organization for what is not part of a project", async () => {
        expect(await deployTargetOrgId("registry", "r")).toBeNull();
        expect(await deployTargetOrgId("volume", "v")).toBeNull();
        expect(await deployTargetOrgId(undefined, undefined)).toBeNull();
    });

    it("stamps the entry, and lets an explicit organization win", async () => {
        await recordDeployAudit({ actorId: "u", action: "deploy.app.deploy", targetType: "application", targetId: "a" });
        await recordDeployAudit({ actorId: "u", orgId: "org-before-delete", action: "deploy.project.delete", targetType: "project", targetId: "p" });
        expect(recorded).toEqual([
            { orgId: "org-a", action: "deploy.app.deploy" },
            { orgId: "org-before-delete", action: "deploy.project.delete" }
        ]);
    });
});
