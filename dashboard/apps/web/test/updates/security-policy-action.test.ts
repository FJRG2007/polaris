/**
 * Saving the security update schedule. Leaving a critical or high fix to wait
 * is refused without the administrator's acceptance of the risk, and recorded
 * with who accepted it; changing medium or low beside an accepted risk keeps
 * that acceptance rather than asking again.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({ policy: null as unknown }));
const recordAudit = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/session", () => ({ requireAdmin: async () => ({ id: "admin-1", isAdmin: true }) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/update-changelog", () => ({
    DEFAULT_QUIET_HOUR: 4,
    getSecurityUpdatePolicy: async () => (stored.policy ?? core.DEFAULT_SECURITY_UPDATE) as core.SecurityUpdatePolicy,
    saveSecurityUpdatePolicy: async (policy: unknown) => {
        stored.policy = policy;
    },
    quietHour: async () => 3,
    updateChangelog: vi.fn()
}));
vi.mock("@/lib/update-watcher", () => ({
    getAutoUpdatePolicy: vi.fn(),
    saveAutoUpdatePolicy: vi.fn(),
    startUpdate: vi.fn()
}));
vi.mock("@/lib/update-service", () => ({ getUpdateStatus: vi.fn(), resetUpdateStatus: vi.fn() }));
vi.mock("@/lib/update-source", () => ({ saveUpdateSource: vi.fn() }));
vi.mock("@/lib/update-report", () => ({ collectUpdateReport: vi.fn(), issueUrl: vi.fn() }));
vi.mock("@/lib/security/own-images", () => ({ ownVulnerabilities: vi.fn() }));
vi.mock("@/lib/legal/service", () => ({ setLegalContact: vi.fn() }));

const { saveSecurityUpdateAction, securityUpdatePolicyAction } = await import(
    "@/app/(app)/admin/updates/actions"
);

const SAFE = { critical: "immediate", high: "immediate", medium: "off", low: "off" } as const;

beforeEach(() => {
    stored.policy = null;
    recordAudit.mockClear();
});

describe("saving how security fixes install", () => {
    it("saves medium and low freely", async () => {
        const result = await saveSecurityUpdateAction({ ...SAFE, medium: "quiet", low: "quiet" });
        expect(result.policy).toMatchObject({ medium: "quiet", low: "quiet", riskAccepted: null });
        expect(recordAudit).toHaveBeenCalledTimes(1);
    });

    it("refuses to leave a critical or high fix waiting without the risk accepted", async () => {
        for (const change of [{ critical: "off" }, { high: "quiet" }]) {
            const result = await saveSecurityUpdateAction({ ...SAFE, ...change });
            expect(result.error).toBe("settings.security.errors.riskNotAccepted");
        }
        expect(stored.policy).toBeNull();
    });

    it("records who accepted the risk, and when", async () => {
        const result = await saveSecurityUpdateAction({ ...SAFE, high: "off", acceptRisk: true });
        expect(result.policy?.high).toBe("off");
        expect(result.policy?.riskAccepted?.by).toBe("admin-1");
        expect(Date.parse(result.policy!.riskAccepted!.at)).not.toBeNaN();
    });

    it("keeps an accepted risk when only medium or low change", async () => {
        const first = await saveSecurityUpdateAction({ ...SAFE, high: "quiet", acceptRisk: true });
        const second = await saveSecurityUpdateAction({ ...SAFE, high: "quiet", low: "quiet" });
        expect(second.error).toBeUndefined();
        expect(second.policy?.riskAccepted).toEqual(first.policy?.riskAccepted);
    });

    it("drops the acceptance once critical and high install at once again", async () => {
        await saveSecurityUpdateAction({ ...SAFE, critical: "off", acceptRisk: true });
        const back = await saveSecurityUpdateAction(SAFE);
        expect(back.policy?.riskAccepted).toBeNull();
    });

    it("refuses what is not a schedule", async () => {
        expect((await saveSecurityUpdateAction({ ...SAFE, critical: "later" })).error).toBe(
            "settings.security.errors.invalid"
        );
        expect((await saveSecurityUpdateAction(null)).error).toBe("settings.security.errors.invalid");
    });

    it("reads back the policy with the quiet hour", async () => {
        expect(await securityUpdatePolicyAction()).toEqual({
            policy: core.DEFAULT_SECURITY_UPDATE,
            quietHour: 3
        });
    });
});
