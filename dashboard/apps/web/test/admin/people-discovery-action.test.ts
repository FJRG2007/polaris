/**
 * The discovery policy is the operator's: only an administrator sets it, only
 * the four switches are accepted, and every change lands in the audit log.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let admin = true;
const setDiscoveryPolicy = vi.fn(async () => {});
const recordAudit = vi.fn(async () => {});

vi.mock("@/lib/session", () => ({
    requireAdmin: async () => {
        if (!admin) throw new Error("NEXT_REDIRECT");
        return { id: "admin", isAdmin: true };
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("@/lib/people-search", () => ({ setDiscoveryPolicy }));
vi.mock("@/lib/access-live", () => ({}));
vi.mock("@/lib/setting-store", () => ({}));
vi.mock("@/lib/profile-service", () => ({}));
vi.mock("@/lib/privacy-service", () => ({}));
vi.mock("@/lib/sharing-policy", () => ({}));
vi.mock("@/lib/account-recovery-service", () => ({}));
vi.mock("@/lib/invite-service", () => ({}));
vi.mock("@/lib/user-admin-service", () => ({}));
vi.mock("@/lib/session-directory", () => ({}));
vi.mock("@/lib/device-sessions/sessions", () => ({}));

const { setDiscoveryPolicyAction } = await import("@/app/(app)/admin/users/actions");

const policy = {
    usernameExact: true,
    usernamePartial: false,
    namePartial: true,
    emailExact: false
};

beforeEach(() => {
    admin = true;
    setDiscoveryPolicy.mockClear();
    recordAudit.mockClear();
});

describe("setting how people can be found", () => {
    it("saves and audits a whole policy", async () => {
        expect(await setDiscoveryPolicyAction(policy)).toEqual({});
        expect(setDiscoveryPolicy).toHaveBeenCalledWith(policy);
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "settings.people-discovery", metadata: policy })
        );
    });

    it("refuses somebody who is not an administrator", async () => {
        admin = false;
        await expect(setDiscoveryPolicyAction(policy)).rejects.toThrow();
        expect(setDiscoveryPolicy).not.toHaveBeenCalled();
    });

    it("refuses a missing, mistyped or extra field", async () => {
        for (const input of [
            { ...policy, emailExact: undefined },
            { ...policy, namePartial: "yes" },
            { ...policy, everybody: true },
            null
        ]) {
            expect(await setDiscoveryPolicyAction(input)).toEqual({
                error: "users.errors.checkSettings"
            });
        }
        expect(setDiscoveryPolicy).not.toHaveBeenCalled();
    });
});
