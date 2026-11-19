import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));

import { androidCertFingerprints, assetLinks, ANDROID_PACKAGE } from "@/lib/mobile/asset-links";

describe("asset links", () => {
    it("always names the release key, and adds only well-formed listed ones", () => {
        const extra = "aa:".repeat(31) + "aa, not-a-fingerprint";
        const prints = androidCertFingerprints(extra);
        expect(prints).toHaveLength(2);
        expect(prints[1]).toBe("AA:".repeat(31) + "AA");
        expect(androidCertFingerprints(undefined)).toHaveLength(1);
    });

    it("lets the app use this host's passkeys", () => {
        const [statement] = assetLinks(["X"]);
        expect(statement.relation).toContain("delegate_permission/common.get_login_creds");
        expect(statement.target).toEqual({ namespace: "android_app", package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: ["X"] });
    });
});
