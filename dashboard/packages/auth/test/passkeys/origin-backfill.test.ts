/**
 * A passkey added before Polaris recorded where it was added from gets that filled
 * in on its next sign-in - marked as first seen on use, and never over a recorded
 * origin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const passkey = { updateMany: vi.fn(), update: vi.fn(), findMany: vi.fn() };

vi.mock("@polaris/db", () => ({ prisma: { passkey } }));

const { backfillPasskeyOrigin } = await import("../../src/auth.js");

const AT = new Date("2026-11-21T10:00:00Z");
const ORIGIN = {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1",
    userAgentBrands: undefined,
    userAgentPlatform: '"iOS"',
    ip: "203.0.113.7"
};

describe("backfillPasskeyOrigin", () => {
    beforeEach(() => passkey.updateMany.mockReset());

    it("fills a row with no browser on record and marks it first seen on use", async () => {
        passkey.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 });
        await backfillPasskeyOrigin("cred-1", ORIGIN, AT);
        expect(passkey.updateMany).toHaveBeenNthCalledWith(1, {
            where: { credentialID: "cred-1", userAgent: null },
            data: {
                userAgent: ORIGIN.userAgent,
                userAgentBrands: null,
                userAgentPlatform: '"iOS"',
                originSeenAt: AT
            }
        });
        // The address only where none was recorded.
        expect(passkey.updateMany).toHaveBeenNthCalledWith(2, {
            where: { credentialID: "cred-1", ip: null },
            data: { ip: "203.0.113.7" }
        });
    });

    it("leaves a row that already recorded its browser alone", async () => {
        passkey.updateMany.mockResolvedValueOnce({ count: 0 });
        await backfillPasskeyOrigin("cred-2", ORIGIN, AT);
        expect(passkey.updateMany).toHaveBeenCalledTimes(1);
    });

    it("records nothing when the request named no browser", async () => {
        await backfillPasskeyOrigin("cred-3", { ip: "203.0.113.7" }, AT);
        expect(passkey.updateMany).not.toHaveBeenCalled();
    });
});
