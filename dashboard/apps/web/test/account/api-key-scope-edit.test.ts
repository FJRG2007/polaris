/**
 * Editing an API key's scopes from the account screen: what is saved is cut
 * to what the owner holds, whatever the form posted, and the change is written
 * to the audit log that raises the security alert.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    held: ["tasks.read", "deploy.read"] as string[],
    saved: [] as { userId: string; scopes: string[] }[],
    audit: [] as { action: string; metadata?: unknown }[]
}));

vi.mock("@polaris/auth", () => ({
    scopesAvailableTo: async () => state.held,
    updateApiKey: async (userId: string, input: { scopes: string[] }) => {
        state.saved.push({ userId, scopes: input.scopes });
    },
    createApiKey: vi.fn(),
    deleteApiKey: vi.fn(),
    revokeApiKey: vi.fn()
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1", isAdmin: false })
}));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/audit-service", () => ({
    recordAudit: async (event: { action: string; metadata?: unknown }) => {
        state.audit.push(event);
    }
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({
    localized: async (result: unknown) => result,
    firstIssue: () => ({ error: "invalid" })
}));

const { updateApiKeyAction } = await import("@/app/(app)/account/api-keys/actions");

const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

beforeEach(() => {
    state.held = ["tasks.read", "deploy.read"];
    state.saved = [];
    state.audit = [];
});

describe("changing an API key's scopes", () => {
    it("saves only what the owner holds, and audits the new set", async () => {
        const result = await updateApiKeyAction({
            id: ID,
            name: "Deploy bot",
            scopes: ["tasks.read", "users.manage"]
        });
        expect(result).toEqual({});
        expect(state.saved).toEqual([{ userId: "user-1", scopes: ["tasks.read"] }]);
        expect(state.audit).toEqual([
            expect.objectContaining({
                action: "account.api-key.updated",
                metadata: { scopes: ["tasks.read"] }
            })
        ]);
    });

    it("refuses a set the owner holds none of, and writes nothing", async () => {
        const result = await updateApiKeyAction({
            id: ID,
            name: "Deploy bot",
            scopes: ["users.manage"]
        });
        expect(result.error).toBe("apiKeys.form.noneHeld");
        expect(state.saved).toEqual([]);
        expect(state.audit).toEqual([]);
    });
});
