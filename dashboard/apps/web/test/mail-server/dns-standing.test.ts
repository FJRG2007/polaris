/**
 * Which mail domains the operator's Cloudflare token may be used for, and which
 * ones somebody may add to a mail server at all. A domain on the operator's own
 * account is not somebody else's to receive mail for until they have verified it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    provenDomainOf: vi.fn(),
    loadCloudflareToken: vi.fn(),
    resolveZoneForHostname: vi.fn()
}));

vi.mock("@/lib/dns/zone-records", () => ({ provenDomainOf: mocks.provenDomainOf }));
vi.mock("@/lib/integrations/cloudflare-account-service", () => ({ loadCloudflareToken: mocks.loadCloudflareToken }));
vi.mock("@/lib/integrations/cloudflare-api", () => ({ resolveZoneForHostname: mocks.resolveZoneForHostname }));
vi.mock("@/lib/mail-server/access", () => ({ MailServerAccessError: class extends Error {} }));

const { publishWithin, requireMailDomainStanding } = await import("@/lib/mail-server/dns-standing");

const admin = { id: "admin", isAdmin: true };
const member = { id: "member", isAdmin: false };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.provenDomainOf.mockResolvedValue(null);
    mocks.loadCloudflareToken.mockResolvedValue("token");
    mocks.resolveZoneForHostname.mockResolvedValue({ id: "zone-1", name: "example.com" });
});

describe("publishing with the operator's token", () => {
    it("lets whoever runs this Polaris publish anywhere the token reaches", async () => {
        await expect(publishWithin(admin, null, "example.com")).resolves.toBeNull();
        expect(mocks.provenDomainOf).not.toHaveBeenCalled();
    });

    it("narrows anybody else to the domain they verified", async () => {
        mocks.provenDomainOf.mockResolvedValue("example.com");
        await expect(publishWithin(member, "org-1", "mail.example.com")).resolves.toBe("example.com");
        expect(mocks.provenDomainOf).toHaveBeenCalledWith("mail.example.com", [
            { kind: "user", id: "member" },
            { kind: "org", id: "org-1" }
        ]);
    });

    it("refuses a domain nobody on this shelf verified", async () => {
        await expect(publishWithin(member, null, "example.com")).rejects.toThrow(/verified under Domains/);
    });
});

describe("adding a mail domain", () => {
    it("refuses a domain on the operator's Cloudflare account the caller has not verified", async () => {
        await expect(requireMailDomainStanding(member, null, "example.com")).rejects.toThrow(/own DNS account/);
    });

    it("takes a domain the caller verified, or one hosted anywhere else", async () => {
        mocks.provenDomainOf.mockResolvedValueOnce("example.com");
        await expect(requireMailDomainStanding(member, null, "example.com")).resolves.toBeUndefined();
        mocks.resolveZoneForHostname.mockRejectedValueOnce(new Error("not on a domain in this Cloudflare account"));
        await expect(requireMailDomainStanding(member, null, "elsewhere.org")).resolves.toBeUndefined();
    });

    it("asks nothing of an administrator, and refuses nothing without a token", async () => {
        await expect(requireMailDomainStanding(admin, null, "example.com")).resolves.toBeUndefined();
        mocks.loadCloudflareToken.mockResolvedValue(null);
        await expect(requireMailDomainStanding(member, null, "example.com")).resolves.toBeUndefined();
        expect(mocks.resolveZoneForHostname).not.toHaveBeenCalled();
    });
});
