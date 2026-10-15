/**
 * An organization's caps, as the create paths ask about them.
 *
 * Each dimension is held three ways: at the cap the next one is refused with a
 * typed refusal naming the dimension and the cap, under it the next one passes,
 * and an organization with no cap - no row at all, or a row with that column
 * empty - is never refused and never counted. The refusal is the reader's
 * language inside a request and the default language outside one (a sweep, a
 * queued job), where reading the request's locale throws. The database is a fake.
 */

import { translatorFor } from "@/lib/i18n/translate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-7000-8000-0000000000cc";

const state = vi.hoisted(() => ({
    quota: null as Record<string, number | null> | null,
    counts: { members: 0, invited: 0, emailed: 0, teams: 0, projects: 0, services: 0, databases: 0 } as Record<string, number>,
    /** Rows `groupBy` answers with, per model. */
    applicationGroups: [] as { replicas: number; autoscale?: string | null; _sum: { cpuLimit: number | null; memoryLimitMb: number | null } }[],
    databaseGroups: [] as { members: number; _sum: { cpuLimit: number | null; memoryLimitMb: number | null } }[],
    /** How many usage reads were made, so "unset is never counted" can be asserted. */
    reads: 0,
    /** null: outside a request, where reading the locale throws. */
    requestLocale: null as "en-US" | "es-ES" | null
}));

vi.mock("@polaris/db", () => {
    const count = (dimension: string) => async () => {
        state.reads += 1;
        return state.counts[dimension];
    };
    return {
        prisma: {
            organizationQuota: { findUnique: async () => state.quota },
            organizationMember: { count: count("members") },
            organizationInvitation: { count: count("invited") },
            invite: { count: count("emailed") },
            team: { count: count("teams") },
            project: { count: count("projects") },
            application: {
                count: count("services"),
                groupBy: async () => {
                    state.reads += 1;
                    return state.applicationGroups;
                }
            },
            managedDatabase: {
                count: count("databases"),
                groupBy: async () => {
                    state.reads += 1;
                    return state.databaseGroups;
                }
            }
        }
    };
});

vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async (namespace: "accountOrgs") => {
        if (!state.requestLocale) throw new Error("`headers` was called outside a request scope");
        return translatorFor(state.requestLocale, namespace);
    }
}));

const quota = await import("@/lib/orgs/quota-service");

const NO_CAPS = { members: null, teams: null, projects: null, services: null, databases: null, cpus: null, memoryMb: null };

beforeEach(() => {
    state.quota = null;
    state.counts = { members: 0, invited: 0, emailed: 0, teams: 0, projects: 0, services: 0, databases: 0 };
    state.applicationGroups = [];
    state.databaseGroups = [];
    state.reads = 0;
    state.requestLocale = "en-US";
});

describe.each(["projects", "services", "databases"] as const)("the %s cap", (dimension) => {
    it("refuses one more at the cap, naming the dimension and the cap", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 3 };
        state.counts[dimension] = 3;
        const refusal = await quota.assertOrgRoom(ORG, dimension).catch((error: unknown) => error);
        expect(refusal).toBeInstanceOf(quota.OrgQuotaError);
        expect(refusal).toMatchObject({ dimension, limit: 3 });
        expect((refusal as Error).message).toContain("3");
    });

    it("refuses an organization already past the cap, and removes nothing", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 2 };
        state.counts[dimension] = 5;
        await expect(quota.assertOrgRoom(ORG, dimension)).rejects.toBeInstanceOf(quota.OrgQuotaError);
    });

    it("lets one more in under the cap", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 3 };
        state.counts[dimension] = 2;
        await expect(quota.assertOrgRoom(ORG, dimension)).resolves.toBeUndefined();
    });

    it("refuses several at once that would not all fit", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 3 };
        state.counts[dimension] = 2;
        await expect(quota.assertOrgRoom(ORG, dimension, 2)).rejects.toBeInstanceOf(quota.OrgQuotaError);
        await expect(quota.assertOrgRoom(ORG, dimension, 1)).resolves.toBeUndefined();
    });

    it("treats a cap of zero as none allowed", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 0 };
        await expect(quota.assertOrgRoom(ORG, dimension)).rejects.toBeInstanceOf(quota.OrgQuotaError);
    });

    it("never refuses, or counts, an organization with no quota", async () => {
        state.counts[dimension] = 100_000;
        await expect(quota.assertOrgRoom(ORG, dimension)).resolves.toBeUndefined();
        state.quota = { ...NO_CAPS };
        await expect(quota.assertOrgRoom(ORG, dimension)).resolves.toBeUndefined();
        expect(state.reads).toBe(0);
    });

    it("never caps something with no organization", async () => {
        state.quota = { ...NO_CAPS, [dimension]: 0 };
        await expect(quota.assertOrgRoom(null, dimension)).resolves.toBeUndefined();
    });
});

describe("the CPU and memory caps", () => {
    const zero = { cpus: 0, memoryMb: 0 };

    beforeEach(() => {
        // Two services of 1.5 cores and 512 MB at two copies, and one dedicated
        // database of 1 core and 1024 MB: 4 cores and 2048 MB already reserved.
        state.applicationGroups = [{ replicas: 2, _sum: { cpuLimit: 1.5, memoryLimitMb: 512 } }];
        state.databaseGroups = [{ members: 1, _sum: { cpuLimit: 1, memoryLimitMb: 1024 } }];
    });

    it("adds up what services and databases reserve, limit times copies", async () => {
        await expect(quota.reservedByOrg(ORG)).resolves.toEqual({ cpus: 4, memoryMb: 2048 });
    });

    it("counts an autoscaled service at the most copies it may run", async () => {
        state.applicationGroups.push({
            replicas: 2,
            autoscale: JSON.stringify({ min: 1, max: 4, cpuPercent: 70, requestsPerCopy: null }),
            _sum: { cpuLimit: 0.5, memoryLimitMb: 256 }
        });
        await expect(quota.reservedByOrg(ORG)).resolves.toEqual({ cpus: 6, memoryMb: 3072 });
    });

    it("refuses a new reservation past the core cap", async () => {
        state.quota = { ...NO_CAPS, cpus: 4.5 };
        const refusal = await quota
            .assertOrgReservation(ORG, zero, { cpus: 1, memoryMb: 0 })
            .catch((error: unknown) => error);
        expect(refusal).toMatchObject({ dimension: "cpus", limit: 4.5 });
    });

    it("lets an exact fit through, fractions and all", async () => {
        state.quota = { ...NO_CAPS, cpus: 4.5 };
        await expect(quota.assertOrgReservation(ORG, zero, { cpus: 0.5, memoryMb: 0 })).resolves.toBeUndefined();
    });

    it("refuses a new reservation past the memory cap", async () => {
        state.quota = { ...NO_CAPS, memoryMb: 2560 };
        const refusal = await quota
            .assertOrgReservation(ORG, zero, { cpus: 0, memoryMb: 1024 })
            .catch((error: unknown) => error);
        expect(refusal).toMatchObject({ dimension: "memoryMb", limit: 2560 });
    });

    it("always lets a reservation shrink, even past the cap", async () => {
        state.quota = { ...NO_CAPS, cpus: 1, memoryMb: 128 };
        await expect(
            quota.assertOrgReservation(ORG, { cpus: 2, memoryMb: 1024 }, { cpus: 1, memoryMb: 512 })
        ).resolves.toBeUndefined();
    });

    it("never refuses, or adds up, an organization with no CPU or memory cap", async () => {
        state.quota = { ...NO_CAPS, projects: 1 };
        await expect(quota.assertOrgReservation(ORG, zero, { cpus: 4096, memoryMb: 16_000_000 })).resolves.toBeUndefined();
        expect(state.reads).toBe(0);
    });
});

describe("usage on the Limits screen", () => {
    it("counts the owner as a member, who has no member row", async () => {
        state.counts = { members: 2, invited: 0, emailed: 0, teams: 1, projects: 4, services: 7, databases: 3 };
        const usage = await quota.orgQuotaUsage(ORG);
        expect(usage).toEqual({ members: 3, teams: 1, projects: 4, services: 7, databases: 3, cpus: 0, memoryMb: 0 });
    });

    it("counts open invitations as people, the way an invitation is refused", async () => {
        state.counts = { members: 2, invited: 1, emailed: 1, teams: 0, projects: 0, services: 0, databases: 0 };
        const usage = await quota.orgQuotaUsage(ORG);
        expect(usage.members).toBe(5);
    });
});

describe("the refusal's language", () => {
    it("is the reader's inside a request", async () => {
        state.requestLocale = "es-ES";
        const refusal = await quota.quotaRefusal("projects", 2);
        expect(refusal.message).toBe("Tu organización llegó a su límite de 2 proyectos. Pide a un admin que lo suba.");
    });

    it("falls back to the default language outside a request, rather than failing", async () => {
        state.requestLocale = null;
        const refusal = await quota.quotaRefusal("projects", 1);
        expect(refusal).toBeInstanceOf(quota.OrgQuotaError);
        expect(refusal.message).toBe("Your organization reached its limit of 1 project. Ask an admin to raise it.");
    });

    it("reaches a create path outside a request as the same typed refusal", async () => {
        state.requestLocale = null;
        state.quota = { ...NO_CAPS, services: 1 };
        state.counts.services = 1;
        await expect(quota.assertOrgRoom(ORG, "services")).rejects.toThrow(
            "Your organization reached its limit of 1 service. Ask an admin to raise it."
        );
    });
});
