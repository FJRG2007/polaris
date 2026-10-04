/**
 * Making a share link requires being able to download what it shares.
 *
 * A share is served through the connection itself, with no second look at who
 * made it, so `createShareAction` is the only place that can ask. It used to ask
 * only for `shares.create` - enough to publish any path on any connection whose
 * id the caller knew, including one they could not open.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class DriveAccessError extends Error {}
    class DriveLockedError extends Error {}
    return {
        DriveAccessError,
        DriveLockedError,
        authorizeDrive: vi.fn(),
        createShare: vi.fn(async () => ({ id: "33333333-3333-4333-8333-333333333333", token: "tok" }))
    };
});

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({}) }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://share.example.test" }));
vi.mock("@/lib/public-reach", () => ({ ensureShareReachability: async () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/share-service", () => ({ createShare: mocks.createShare }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/request-context", () => ({ clientIp: vi.fn(), hashForLog: vi.fn() }));
vi.mock("@/lib/drive-authz", () => ({
    DriveAccessError: mocks.DriveAccessError,
    DriveLockedError: mocks.DriveLockedError,
    authorizeDrive: mocks.authorizeDrive
}));

const { createShareAction } = await import("@/app/(app)/drive/share-actions");

const CONNECTION = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("createShareAction", () => {
    it("refuses a path the caller cannot download, and makes no share", async () => {
        mocks.authorizeDrive.mockRejectedValueOnce(new mocks.DriveAccessError("no"));
        const result = await createShareAction({ connectionId: CONNECTION, path: "/hr/salaries.xlsx", kind: "public" });
        expect(result).toEqual({ error: "errors.locationDenied" });
        expect(mocks.createShare).not.toHaveBeenCalled();
    });

    it("refuses a locked path", async () => {
        mocks.authorizeDrive.mockRejectedValueOnce(new mocks.DriveLockedError("locked"));
        const result = await createShareAction({ connectionId: CONNECTION, path: "/vault", kind: "public" });
        expect(result).toEqual({ error: "errors.locationLocked" });
        expect(mocks.createShare).not.toHaveBeenCalled();
    });

    it("asks for write as well when the link takes uploads", async () => {
        mocks.authorizeDrive.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new mocks.DriveAccessError("no"));
        const result = await createShareAction({
            connectionId: CONNECTION,
            path: "/inbox",
            kind: "public",
            allowUpload: true
        });
        expect(result.error).toBe("errors.locationDenied");
        expect(mocks.authorizeDrive).toHaveBeenLastCalledWith("user-1", CONNECTION, "/inbox", "write");
        expect(mocks.createShare).not.toHaveBeenCalled();
    });

    it("makes the link when the caller can download it", async () => {
        mocks.authorizeDrive.mockResolvedValue(undefined);
        const result = await createShareAction({ connectionId: CONNECTION, path: "/docs/a.pdf", kind: "public" });
        expect(result.url).toBe("https://share.example.test/s/tok");
        expect(mocks.authorizeDrive).toHaveBeenCalledWith("user-1", CONNECTION, "/docs/a.pdf", "download");
    });
});
