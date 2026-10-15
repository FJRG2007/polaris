/**
 * Who may set an organization's caps, checked on the server.
 *
 * Hiding the fields is not the check: the save action can be called by anybody
 * who can reach the page, including the organization's own owner, who must never
 * be able to raise their own caps. Only an administrator of this Polaris saves;
 * everybody else is refused before anything is read or written. Reading the caps
 * takes being on the roster.
 */

import { translatorFor } from "@/lib/i18n/translate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-7000-8000-0000000000cc";

const state = vi.hoisted(() => ({
    user: { id: "owner-1", isAdmin: false },
    saved: [] as unknown[],
    audited: [] as string[],
    /** Whether the reader is on the roster. */
    onRoster: true
}));

vi.mock("@/lib/session", () => ({ requireUser: async () => state.user }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async ({ action }: { action: string }) => {
        state.audited.push(action);
    }
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async (namespace: "accountOrgs") => translatorFor("en-US", namespace) }));
vi.mock("@/lib/orgs/org-service", async () => {
    const errors = await import("@/lib/orgs/errors");
    return {
        ...errors,
        requireOrgPermission: async () => {
            if (!state.onRoster) throw new errors.OrgAccessError();
            return {};
        }
    };
});
vi.mock("@/lib/orgs/quota-service", () => ({
    setOrgQuota: async (_orgId: string, limits: unknown) => {
        state.saved.push(limits);
    },
    getOrgQuota: async () => null,
    orgQuotaUsage: async () => ({ members: 1, teams: 0, projects: 2, services: 3, databases: 0, cpus: 1.5, memoryMb: 512 })
}));

const { loadOrgQuotaAction, saveOrgQuotaAction } = await import("@/app/(app)/account/organizations/[slug]/limits/actions");

const draft = { members: "", teams: "", projects: "5", services: "", databases: "", cpus: "2.5", memoryMb: "" };

beforeEach(() => {
    state.user = { id: "owner-1", isAdmin: false };
    state.saved = [];
    state.audited = [];
    state.onRoster = true;
});

describe("setting an organization's caps", () => {
    it("refuses anybody who is not an administrator of this Polaris, and writes nothing", async () => {
        const result = await saveOrgQuotaAction(ORG, draft);
        expect(result).toEqual({ error: "Only an administrator of this Polaris can change these limits." });
        expect(state.saved).toEqual([]);
        expect(state.audited).toEqual([]);
    });

    it("saves an administrator's caps, blank as no cap, and records it", async () => {
        state.user = { id: "admin-1", isAdmin: true };
        const result = await saveOrgQuotaAction(ORG, draft);
        const limits = { members: null, teams: null, projects: 5, services: null, databases: null, cpus: 2.5, memoryMb: null };
        expect(result).toEqual({ limits });
        expect(state.saved).toEqual([limits]);
        expect(state.audited).toEqual(["org.quota"]);
    });

    it("refuses a cap that is not a number, in words", async () => {
        state.user = { id: "admin-1", isAdmin: true };
        const result = await saveOrgQuotaAction(ORG, { ...draft, projects: "-1" });
        expect(result.error).toBeTruthy();
        expect(result.error).not.toMatch(/^quotas\./);
        expect(state.saved).toEqual([]);
    });
});

describe("reading an organization's caps", () => {
    it("shows somebody on the roster the caps and the usage, unlimited when none was set", async () => {
        const result = await loadOrgQuotaAction(ORG);
        expect(result.view?.limits.projects).toBeNull();
        expect(result.view?.usage.services).toBe(3);
    });

    it("refuses somebody who is not on the roster", async () => {
        state.onRoster = false;
        const result = await loadOrgQuotaAction(ORG);
        expect(result.view).toBeUndefined();
        expect(result.error).toBeTruthy();
    });
});
