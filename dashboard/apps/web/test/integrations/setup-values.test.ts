/**
 * Every value a setup step asks for has to be one this deployment can supply.
 *
 * A step that names a value nothing resolves renders as a step with a missing
 * field: the operator reads "paste the privacy policy URL", sees nothing to
 * paste, and either invents one or leaves the vendor's form empty - and both of
 * those come back months later as a failed review. The catalogue and the
 * resolver are checked against each other here because nothing else can.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/connections/oauth", () => ({
    connectionCallbackUrl: (provider: string, baseUrl: string) => `${baseUrl}/api/connections/${provider}/callback`
}));

import { INTEGRATIONS } from "@/lib/integrations/registry";
import { commonSetupValues, hostnameOf, setupValuesFor } from "@/lib/integrations/setup-values";

const BASE = "https://polaris.example.com";

describe("setup values", () => {
    it("resolves every value the catalogue asks for", () => {
        const common = commonSetupValues(BASE);
        for (const entry of INTEGRATIONS) {
            // The OAuth apps are the ones with a callback; the rest never ask for one.
            const values = setupValuesFor(entry.slug, common, { oauthApp: true, baseUrl: BASE });
            for (const step of entry.setupLinks ?? []) {
                for (const kind of step.values ?? []) {
                    expect(values[kind], `${entry.slug}: ${step.label} asks for ${kind}`).toBeTruthy();
                }
            }
        }
    });

    it("only offers a redirect URI to a service that has one", () => {
        const common = commonSetupValues(BASE);
        expect(setupValuesFor("epic", common, { oauthApp: true, baseUrl: BASE }).redirectUri).toBe(
            `${BASE}/api/connections/epic/callback`
        );
        expect(setupValuesFor("virustotal", common, { oauthApp: false, baseUrl: BASE }).redirectUri).toBeUndefined();
    });

    it("builds the public pages and the logo on this deployment's address", () => {
        // Given with a trailing slash on purpose: these are pasted into forms
        // that compare strings, so a doubled slash is a different URL.
        const common = commonSetupValues(`${BASE}/`);
        expect(common.homeUrl).toBe(`${BASE}/about`);
        expect(common.privacyUrl).toBe(`${BASE}/legal/privacy`);
        expect(common.termsUrl).toBe(`${BASE}/legal/terms`);
        expect(common.logoUrl).toBe(`${BASE}/polaris-mark-128.png`);
    });

    it("hands over the bare hostname for the fields that refuse a URL", () => {
        expect(hostnameOf(BASE)).toBe("polaris.example.com");
        expect(hostnameOf("https://polaris.example.com:8443/x")).toBe("polaris.example.com");
        // Not a URL at all: shown as it stands rather than swallowed, since it is
        // copied by a person who can see it is wrong.
        expect(hostnameOf("polaris.local")).toBe("polaris.local");
    });
});
