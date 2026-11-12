import { beforeEach, expect, it, vi } from "vitest";

const findDevice = vi.fn();
const claims = { sub: "user-1", stamp: "stamp", device: "extension-1" as string | undefined };
vi.mock("@polaris/db", () => ({
    prisma: {
        vaultAccount: {
            findUnique: async () => ({
                securityStamp: "stamp",
                user: { email: "test@example.test", bannedAt: null }
            })
        },
        vaultDevice: { findUnique: findDevice }
    }
}));
vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_AUTH_SECRET: "test" }) }));
vi.mock("@polaris/auth", () => ({ userHasPermission: async () => true }));
vi.mock("@/lib/vault/tokens", () => ({ readAccessToken: () => claims }));
const { authenticateVault } = await import("@/lib/vault/auth");
const request = () =>
    new Request("https://polaris.test/vault/api/sync", {
        headers: { authorization: "Bearer test" }
    });
beforeEach(() => {
    vi.clearAllMocks();
    claims.device = "extension-1";
    findDevice.mockResolvedValue({ extension: null });
});
it("rejects an already issued JWT after its extension disconnects", async () => {
    findDevice.mockResolvedValue({ extension: { userId: "user-1", revokedAt: null } });
    expect(await authenticateVault(request())).not.toBeNull();
    findDevice.mockResolvedValue({ extension: { userId: "user-1", revokedAt: new Date() } });
    expect(await authenticateVault(request())).toBeNull();
});
it("resolves devices within the token owner's account", async () => {
    findDevice.mockResolvedValue(null);
    expect(await authenticateVault(request())).toBeNull();
    expect(findDevice.mock.calls[0]![0].where).toEqual({
        userId_identifier: { userId: "user-1", identifier: "extension-1" }
    });
});
it("rejects a connection belonging to another account", async () => {
    findDevice.mockResolvedValue({ extension: { userId: "user-2", revokedAt: null } });
    expect(await authenticateVault(request())).toBeNull();
});
it("preserves clients without extension connections and tokens without devices", async () => {
    expect(await authenticateVault(request())).not.toBeNull();
    claims.device = undefined;
    expect(await authenticateVault(request())).not.toBeNull();
});
