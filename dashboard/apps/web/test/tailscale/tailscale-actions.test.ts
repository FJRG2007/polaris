/**
 * The Tailscale actions answer administrators only, validate what they are sent
 * before anything starts, and turn a refusal into a sentence rather than a throw.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { id: "admin-1", isAdmin: true };
const requireAdmin = vi.fn(async (): Promise<unknown> => ADMIN);
const connectTailscale = vi.fn(async (..._args: unknown[]) => undefined);
const setTailscaleToggles = vi.fn(async (..._args: unknown[]) => undefined);
const disconnectTailscale = vi.fn(async () => undefined);
const tailscaleView = vi.fn(async () => ({ edition: "full" }));
class TailscaleRefusal extends Error {}

vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/tailscale/tailscale-service", () => ({
    connectTailscale,
    setTailscaleToggles,
    disconnectTailscale,
    tailscaleView,
    TailscaleRefusal
}));

const actions = await import("../../src/app/(app)/admin/domains/tailscale-actions");

beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockImplementation(async () => ADMIN);
});

describe("tailscale actions", () => {
    it("refuses a caller who is not an administrator before doing anything", async () => {
        requireAdmin.mockImplementation(async () => {
            throw new Error("forbidden");
        });
        await expect(actions.connectTailscaleAction({})).rejects.toThrow("forbidden");
        await expect(
            actions.setTailscaleTogglesAction({ serve: true, funnel: false })
        ).rejects.toThrow("forbidden");
        await expect(actions.disconnectTailscaleAction()).rejects.toThrow("forbidden");
        expect(connectTailscale).not.toHaveBeenCalled();
        expect(setTailscaleToggles).not.toHaveBeenCalled();
        expect(disconnectTailscale).not.toHaveBeenCalled();
    });

    it("refuses a key that is not Tailscale's without starting anything", async () => {
        const result = await actions.connectTailscaleAction({ authKey: "not-a-key" });
        expect(result).toEqual({ view: null, error: "domains.tailscale.badKey" });
        expect(connectTailscale).not.toHaveBeenCalled();
    });

    it("connects with a trimmed key or with none", async () => {
        await actions.connectTailscaleAction({ authKey: " tskey-auth-abc12345 " });
        expect(connectTailscale).toHaveBeenLastCalledWith(
            "tskey-auth-abc12345",
            "domains.tailscale.limited"
        );
        await actions.connectTailscaleAction({ authKey: "" });
        expect(connectTailscale).toHaveBeenLastCalledWith(null, "domains.tailscale.limited");
    });

    it("refuses Funnel without Serve", async () => {
        const result = await actions.setTailscaleTogglesAction({ serve: false, funnel: true });
        expect(result.error).toBe("domains.tailscale.funnelNeedsServe");
        expect(setTailscaleToggles).not.toHaveBeenCalled();
    });

    it("shows a refusal's sentence and hides any other failure", async () => {
        connectTailscale.mockImplementationOnce(async () => {
            throw new TailscaleRefusal("needs the full edition");
        });
        expect((await actions.connectTailscaleAction({})).error).toBe("needs the full edition");
        connectTailscale.mockImplementationOnce(async () => {
            throw new Error("socket refused");
        });
        expect((await actions.connectTailscaleAction({})).error).toBe("domains.tailscale.failed");
    });
});
