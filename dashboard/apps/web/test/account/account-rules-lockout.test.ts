/**
 * Saving the account's access rules, judged against the session making the save:
 * a list that would block it is refused with the rule's name and that session's
 * facts, nothing is written and no session is re-judged; one that only challenges
 * it, or does not touch it, is saved. The preview says the same without saving.
 */

import type { AccountRule } from "@polaris/core";
import { translatorFor } from "../../src/lib/i18n/translate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
    save: vi.fn(async (_userId: string, _rules: unknown) => undefined),
    revoke: vi.fn(async (_userId: string) => 0),
    audit: vi.fn(async (_entry: unknown) => undefined)
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: "u1" }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: spies.audit }));
vi.mock("@/lib/session-guard", () => ({ revokeSessionsRefusedByRules: spies.revoke }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async (namespace: "account") => translatorFor("en-US", namespace)
}));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "203.0.113.9",
    clientUserAgent: async () =>
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
    clientUserAgentBrands: async () => undefined,
    clientUserAgentPlatform: async () => undefined
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@polaris/auth", () => ({ resolveEnforcedRules: async () => null }));
vi.mock("@/lib/geo-service", () => ({ resolveGeo: async () => ({ countryCode: "ES" }) }));
vi.mock("@/lib/integrations/dymo", () => ({ verifyIp: async () => null }));
vi.mock("@/lib/network-rules", () => ({ evaluateNetworkRules: async () => null }));
vi.mock("@/lib/integrations/provider-pause", () => ({ takeServedLookup: async () => null }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationSecret: async () => null,
    getIntegrationState: async () => null
}));
vi.mock("@/lib/account-rules", async (importActual) => ({
    ...(await importActual<typeof import("@/lib/account-rules")>()),
    listAccountRules: async () => [],
    saveAccountRules: spies.save
}));

const { previewAccountRulesAction, saveAccountRulesAction } = await import("@/app/(app)/account/access/rule-actions");

function rule(name: string, action: AccountRule["action"], values: string[]): AccountRule {
    return { name, enabled: true, action, timeZone: "UTC", conditions: [{ field: "os", operator: "equals", values }] };
}

beforeEach(() => {
    spies.save.mockClear();
    spies.revoke.mockClear();
    spies.audit.mockClear();
});

describe("saving access rules against the current session", () => {
    it("refuses a list that would block this session, naming the rule, and writes nothing", async () => {
        const result = await saveAccountRulesAction([rule("No Mac", "block", ["macOS"])]);
        expect(result.error).toContain("\"No Mac\" would block the session you are using right now");
        expect(result.error !== undefined && result.lockout).toMatchObject({
            action: "block",
            ruleName: "No Mac",
            ip: "203.0.113.9",
            os: "macOS"
        });
        expect(spies.save).not.toHaveBeenCalled();
        expect(spies.revoke).not.toHaveBeenCalled();
        expect(spies.audit).not.toHaveBeenCalled();
    });

    it("lets an allow above the block carve this session out, first match wins", async () => {
        const result = await saveAccountRulesAction([
            rule("This Mac", "allow", ["macOS"]),
            rule("No Mac", "block", ["macOS"])
        ]);
        expect(result.error).toBeUndefined();
        expect(spies.save).toHaveBeenCalledTimes(1);
        expect(spies.revoke).toHaveBeenCalledWith("u1");
    });

    it("saves a list that only challenges this session", async () => {
        const result = await saveAccountRulesAction([rule("Verify Mac", "challenge", ["macOS"])]);
        expect(result.error).toBeUndefined();
        expect(spies.save).toHaveBeenCalledTimes(1);
    });

    it("ignores a disabled blocking rule", async () => {
        const result = await saveAccountRulesAction([{ ...rule("No Mac", "block", ["macOS"]), enabled: false }]);
        expect(result.error).toBeUndefined();
    });

    it("rejects a malformed list before judging it", async () => {
        const result = await saveAccountRulesAction([{ name: "", enabled: true, action: "block", conditions: [] }]);
        expect(result.error).toBeTruthy();
        expect(spies.save).not.toHaveBeenCalled();
    });

    it("previews the verdict without saving", async () => {
        const result = await previewAccountRulesAction([rule("No Mac", "block", ["macOS"])]);
        expect(result.error === undefined && result.preview).toMatchObject({ action: "block", ruleName: "No Mac" });
        expect(spies.save).not.toHaveBeenCalled();
    });
});
