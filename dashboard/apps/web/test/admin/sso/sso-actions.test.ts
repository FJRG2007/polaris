/**
 * Single sign-on providers answer administrators only. A refused caller saves,
 * checks and removes nothing, and what an administrator sends is parsed with
 * the form's own schema before anything is stored.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { id: "admin-1", isAdmin: true };
const requireAdmin = vi.fn(async (): Promise<unknown> => ADMIN);
const recordAudit = vi.fn(async () => undefined);
const saveSamlProvider = vi.fn(async () => VIEW);
const checkSamlProvider = vi.fn(async () => ({ checks: [{ key: "certificate", ok: true }], provider: VIEW }));
const deleteSamlProvider = vi.fn(async () => undefined);

class SamlProviderError extends Error {
    constructor(readonly problem: string) {
        super(problem);
    }
}

const VIEW = {
    providerId: "saml-abcdef123456",
    name: "Example",
    domains: ["example.com"],
    allowSignUp: false,
    enforced: true,
    domainVerified: false,
    entityId: "https://idp.example.com",
    ssoUrl: "https://idp.example.com/sso",
    mapping: { email: "email", name: "displayName" },
    serviceProvider: { entityId: "e", acsUrl: "a", metadataUrl: "m" },
    records: []
};

vi.mock("@/lib/session", () => ({ requireAdmin }));
vi.mock("@/lib/audit-service", () => ({ recordAudit }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/saml-providers", () => ({
    SamlProviderError,
    saveSamlProvider,
    checkSamlProvider,
    deleteSamlProvider
}));

const actions = await import("@/app/(app)/admin/sso/actions");

/** What `requireAdmin` does to a non-admin: Next's redirect, which throws. */
const redirected = () =>
    Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/home?denied=1;307;" });

const INPUT = {
    name: "Example",
    domains: ["Example.com"],
    source: { kind: "metadataUrl", url: "https://idp.example.com/metadata" },
    mapping: { email: "email", name: "displayName" },
    allowSignUp: false,
    enforced: true
};

beforeEach(() => {
    vi.clearAllMocks();
    requireAdmin.mockResolvedValue(ADMIN);
});

describe("single sign-on actions", () => {
    it("refuses a caller who is not an administrator before touching a provider", async () => {
        requireAdmin.mockRejectedValue(redirected());
        await expect(actions.saveSamlProviderAction(INPUT, null)).rejects.toThrow("NEXT_REDIRECT");
        await expect(actions.checkSamlProviderAction(VIEW.providerId)).rejects.toThrow("NEXT_REDIRECT");
        await expect(actions.deleteSamlProviderAction(VIEW.providerId)).rejects.toThrow("NEXT_REDIRECT");
        expect(saveSamlProvider).not.toHaveBeenCalled();
        expect(checkSamlProvider).not.toHaveBeenCalled();
        expect(deleteSamlProvider).not.toHaveBeenCalled();
        expect(recordAudit).not.toHaveBeenCalled();
    });

    it("saves what the schema accepts, normalized, and records it", async () => {
        const outcome = await actions.saveSamlProviderAction(INPUT, null);
        expect(outcome.ok).toBe(true);
        expect(saveSamlProvider).toHaveBeenCalledWith(
            expect.objectContaining({ domains: ["example.com"] }),
            ADMIN.id,
            null
        );
        expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "instance.sso.created" }));
    });

    it("refuses an invalid form, and a plain-http metadata address, without saving", async () => {
        expect(await actions.saveSamlProviderAction({ ...INPUT, domains: [] }, null)).toMatchObject({
            ok: false,
            problem: "invalid"
        });
        const http = { ...INPUT, source: { kind: "metadataUrl", url: "http://idp.example.com/metadata" } };
        expect(await actions.saveSamlProviderAction(http, null)).toMatchObject({ ok: false, problem: "invalid" });
        expect(saveSamlProvider).not.toHaveBeenCalled();
    });

    it("refuses a provider id that is not one of ours", async () => {
        expect(await actions.saveSamlProviderAction(INPUT, "../etc")).toMatchObject({ ok: false, problem: "notFound" });
        expect(await actions.deleteSamlProviderAction("saml-x")).toMatchObject({ ok: false, problem: "notFound" });
        expect(saveSamlProvider).not.toHaveBeenCalled();
        expect(deleteSamlProvider).not.toHaveBeenCalled();
    });

    it("answers a known refusal by its key and anything else generically", async () => {
        saveSamlProvider.mockRejectedValueOnce(new SamlProviderError("domainTaken"));
        expect(await actions.saveSamlProviderAction(INPUT, null)).toEqual({ ok: false, problem: "domainTaken" });
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
        checkSamlProvider.mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
        expect(await actions.checkSamlProviderAction(VIEW.providerId)).toEqual({ ok: false, problem: "failed" });
        logged.mockRestore();
    });
});
