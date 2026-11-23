/**
 * The admin's count of accounts moved to OPAQUE: two counts in the database over
 * accounts that have a password, the moved one narrowed to a verified record.
 */

import { describe, expect, it, vi } from "vitest";

const count = vi.hoisted(() => vi.fn());

vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@polaris/db", () => ({ prisma: { account: { count } }, Prisma: {} }));
vi.mock("@/lib/request-context", () => ({ clientIp: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/chat/e2ee/clear-password-pool", () => ({ passwordOpensRecordOffThread: vi.fn() }));

const { passwordMigrationCounts } = await import("@/lib/chat/e2ee/opaque-service");

describe("passwordMigrationCounts", () => {
    it("counts accounts with a password, and those with a verified record", async () => {
        count.mockImplementation(async ({ where }: { where: { user?: unknown } }) => (where.user ? 3 : 10));
        expect(await passwordMigrationCounts()).toEqual({ moved: 3, total: 10 });
        const withPassword = { providerId: "credential", password: { not: null } };
        expect(count).toHaveBeenCalledWith({ where: withPassword });
        expect(count).toHaveBeenCalledWith({
            where: { ...withPassword, user: { opaqueRecord: { verifiedAt: { not: null } } } }
        });
    });
});
