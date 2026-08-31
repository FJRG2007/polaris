/**
 * What somebody writing an access entry may put in it.
 *
 * Managing access is a capability like any other, so the entry that administers
 * the roster while staying out of the variables is exactly the one that must not
 * be able to write itself the variables. The ceiling is the granter's own
 * standing - capabilities and environments both - and a roster they are not on
 * is not theirs to hand a project to.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_ROLE_CAPABILITIES, expandProjectCapabilities } from "@polaris/core";

const memberFindFirst = vi.fn();
const memberCreate = vi.fn();
const memberUpdate = vi.fn();
const environmentFindMany = vi.fn();
const userFindUnique = vi.fn();
const userFindFirst = vi.fn();
const projectFindUnique = vi.fn();
const teamFindFirst = vi.fn();
const orgFindFirst = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        project: { findUnique: projectFindUnique },
        projectMember: {
            findFirst: memberFindFirst,
            create: memberCreate,
            update: memberUpdate,
            deleteMany: vi.fn()
        },
        environment: { findMany: environmentFindMany },
        user: { findUnique: userFindUnique, findFirst: userFindFirst },
        team: { findFirst: teamFindFirst },
        organization: { findFirst: orgFindFirst, findMany: vi.fn() },
        apiKey: { findMany: vi.fn() }
    }
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@polaris/deploy", () => ({ slugify: (value: string) => value }));
vi.mock("@polaris/auth", () => ({ createApiKey: vi.fn() }));
vi.mock("@polaris/storage", () => ({ decryptSecret: vi.fn(), encryptSecret: vi.fn() }));
vi.mock("@/lib/privacy-service", () => ({ contactLines: async () => new Map<string, string>() }));
vi.mock("../../src/lib/notifications/webhook-sender", () => ({ sendWebhook: vi.fn() }));

const { setProjectAccess } = await import("../../src/lib/deploy-project-service");

const ADMIN_SET = expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.admin);

/** Somebody who administers the roster and is deliberately kept out of the rest. */
const ROSTER_ONLY = ["project.read", "members.manage"] as const;

function entry(overrides: Record<string, unknown> = {}) {
    return {
        projectId: "project-1",
        principal: "user" as const,
        principalId: "helper-2",
        environmentIds: [] as string[],
        granter: { id: "granter-1", capabilities: ADMIN_SET, environmentIds: null },
        ...overrides
    };
}

describe("setProjectAccess", () => {
    beforeEach(() => {
        memberFindFirst.mockReset();
        memberCreate.mockReset();
        memberUpdate.mockReset();
        environmentFindMany.mockReset();
        userFindUnique.mockReset();
        teamFindFirst.mockReset();
        orgFindFirst.mockReset();
        projectFindUnique.mockResolvedValue({ ownerId: "owner-1" });
        userFindUnique.mockResolvedValue({ id: "helper-2" });
        memberFindFirst.mockResolvedValue(null);
        environmentFindMany.mockResolvedValue([]);
    });

    it("writes what an admin asks for", async () => {
        await setProjectAccess(entry({ role: "developer" }));
        const written = memberCreate.mock.calls[0]?.[0]?.data;
        expect(JSON.parse(written.capabilities)).toEqual(
            expandProjectCapabilities(PROJECT_ROLE_CAPABILITIES.developer)
        );
        expect(written.invitedBy).toBe("granter-1");
    });

    it("refuses a role reaching past what the granter holds themselves", async () => {
        await expect(
            setProjectAccess(
                entry({
                    role: "admin",
                    granter: { id: "granter-1", capabilities: ROSTER_ONLY, environmentIds: null }
                })
            )
        ).rejects.toThrow(/only give away what you can do/i);
        expect(memberCreate).not.toHaveBeenCalled();
    });

    it("refuses one capability picked past that ceiling, and allows one inside it", async () => {
        const granter = { id: "granter-1", capabilities: ROSTER_ONLY, environmentIds: null };
        await expect(
            setProjectAccess(entry({ capabilities: ["variables.read"], granter }))
        ).rejects.toThrow(/only give away what you can do/i);

        await setProjectAccess(entry({ capabilities: ["members.manage"], granter }));
        expect(JSON.parse(memberCreate.mock.calls[0]?.[0]?.data.capabilities)).toEqual([
            "project.read",
            "members.manage"
        ]);
    });

    it("refuses an entry reaching an environment the granter does not", async () => {
        environmentFindMany.mockResolvedValue([{ id: "env-prod" }]);
        await expect(
            setProjectAccess(
                entry({
                    role: "viewer",
                    environmentIds: ["env-prod"],
                    granter: { id: "granter-1", capabilities: ADMIN_SET, environmentIds: ["env-dev"] }
                })
            )
        ).rejects.toThrow(/environments you reach yourself/i);
    });

    it("refuses every environment from somebody limited to one", async () => {
        await expect(
            setProjectAccess(
                entry({
                    role: "viewer",
                    environmentIds: [],
                    granter: { id: "granter-1", capabilities: ADMIN_SET, environmentIds: ["env-dev"] }
                })
            )
        ).rejects.toThrow(/environments you reach yourself/i);
    });

    it("takes an environment the granter does reach", async () => {
        environmentFindMany.mockResolvedValue([{ id: "env-dev" }]);
        await setProjectAccess(
            entry({
                role: "viewer",
                environmentIds: ["env-dev"],
                granter: { id: "granter-1", capabilities: ADMIN_SET, environmentIds: ["env-dev"] }
            })
        );
        expect(JSON.parse(memberCreate.mock.calls[0]?.[0]?.data.environments)).toEqual(["env-dev"]);
    });

    it("refuses a team the granter is not on", async () => {
        teamFindFirst.mockResolvedValue(null);
        await expect(
            setProjectAccess(
                entry({ principal: "team", principalId: "team-9", role: "viewer" })
            )
        ).rejects.toThrow(/teams you are on/i);
        expect(teamFindFirst.mock.calls[0]?.[0]?.where.org).toBeDefined();
    });

    it("refuses an organization the granter is not in", async () => {
        orgFindFirst.mockResolvedValue(null);
        await expect(
            setProjectAccess(entry({ principal: "org", principalId: "org-9", role: "viewer" }))
        ).rejects.toThrow(/organizations you are in/i);
    });
});
