/**
 * The team cap, as `createTeam` holds it beside the instance's own team limit:
 * at the cap the next team is refused and nothing is written, under it the team
 * is made, and an organization with no cap is only held to the instance's limit.
 * The database is a fake.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-7000-8000-0000000000cc";

const state = vi.hoisted(() => ({
    quota: null as Record<string, number | null> | null,
    teams: 0,
    created: 0
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        organizationQuota: { findUnique: async () => state.quota },
        team: {
            count: async () => state.teams,
            findUnique: async () => null,
            create: async () => {
                state.created += 1;
                return { id: "team-1" };
            }
        }
    }
}));
vi.mock("@/lib/orgs/policy", () => ({
    organizationPolicy: async () => ({ maxTeams: 50, maxMembers: 50 })
}));
vi.mock("@/lib/orgs/role-service", () => ({
    ensureSystemRoles: async () => undefined,
    roleIsRestricted: async () => false
}));
vi.mock("@/lib/privacy-service", () => ({ contactLines: async () => new Map<string, string>() }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/successor-service", () => ({ isOrgSuccessor: async () => false }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => {
        throw new Error("outside a request");
    }
}));

const { createTeam } = await import("@/lib/orgs/org-service");
const { OrgQuotaError } = await import("@/lib/orgs/quota-service");

const input = { slug: "platform", name: "Platform", description: "" };

beforeEach(() => {
    state.quota = null;
    state.teams = 0;
    state.created = 0;
});

describe("the team cap", () => {
    it("refuses a team at the cap and writes nothing", async () => {
        state.quota = { teams: 2 };
        state.teams = 2;
        await expect(createTeam(ORG, input)).rejects.toBeInstanceOf(OrgQuotaError);
        expect(state.created).toBe(0);
    });

    it("makes a team under the cap", async () => {
        state.quota = { teams: 2 };
        state.teams = 1;
        await expect(createTeam(ORG, input)).resolves.toBe("team-1");
    });

    it("leaves an organization with no cap to the instance's limit only", async () => {
        state.teams = 40;
        await expect(createTeam(ORG, input)).resolves.toBe("team-1");
        state.quota = { teams: null, projects: 1 };
        await expect(createTeam(ORG, input)).resolves.toBe("team-1");
    });
});
