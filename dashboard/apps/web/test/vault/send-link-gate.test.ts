/**
 * A Send runs the start, hours and account rules through the one shared link
 * check, on the access endpoint every opener goes through. A Bitwarden client
 * never carries a Polaris session, so a Send that needs an account refuses it,
 * with a message that says where it does open.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { LINK_GUARD_SELECT, linkGuardCases } from "../helpers/link-guard-cases";

const findUnique = vi.fn();
const update = vi.fn(async () => ({}));
const updateMany = vi.fn();
vi.mock("@polaris/db", () => ({
    prisma: {
        vaultSend: { findUnique, update, updateMany, fields: { accessCount: "accessCount" } },
        user: { findUnique: async () => ({ username: "ana" }) }
    }
}));
vi.mock("@/lib/vault/account", () => ({ bumpRevision: vi.fn(async () => undefined) }));
vi.mock("@/lib/vault/blobs", () => ({ deleteVaultBlob: vi.fn(async () => undefined) }));
const verifyLinkPassword = vi.fn(async () => true);
vi.mock("@polaris/core/link-password", () => ({
    hashLinkPassword: async (value: string) => `hashed:${value}`,
    verifyLinkPassword
}));
vi.mock("@/lib/geo-service", () => ({ geoAllowedForIp: async () => true }));
let viewer: { id: string } | null = null;
vi.mock("@/lib/session", () => ({ guardedUser: async () => viewer }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/dymo-service", () => ({ dymoIpAllowed: async () => ({ allowed: true }) }));
vi.mock("@/lib/request-context", () => ({
    clientIp: async () => "198.51.100.7",
    hashForLog: () => "h"
}));
// The real one pulls in the auth package; this is its response shape.
vi.mock("@/lib/vault/auth", () => ({
    vaultError: (message: string, status = 400) =>
        Response.json({ message, object: "error" }, { status })
}));
vi.mock("@/lib/vault/api/router", () => ({
    readJsonBody: async () => ({}),
    requirePrincipal: () => ({ userId: "u" })
}));

const sends = await import("@/lib/vault/sends");
const api = await import("@/lib/vault/api/sends");

const row = (overrides: Record<string, unknown> = {}) => ({
    id: "send-1",
    accessId: "access-id",
    type: 0,
    data: '{"name":"n"}',
    key: "k",
    passwordHash: null,
    maxAccessCount: null,
    accessCount: 0,
    expirationDate: null,
    deletionDate: new Date(Date.now() + 86_400_000),
    disabled: false,
    hideEmail: true,
    fileSize: null,
    createdAt: new Date(),
    revisionDate: new Date(),
    storedPath: null,
    allowedCidrs: "[]",
    allowedCountries: "[]",
    allowedContinents: "[]",
    startsAt: null,
    requireLogin: false,
    allowedUsers: "[]",
    linkSchedule: "",
    ...overrides
});
const reason = async (overrides: Record<string, unknown>) => {
    findUnique.mockResolvedValueOnce(row(overrides));
    const result = await sends.accessSend("access-id", undefined, "198.51.100.7");
    return result.ok ? "ok" : result.reason;
};
const context = () =>
    ({ request: new Request("https://example.test"), params: { id: "access-id" } }) as never;

beforeEach(() => {
    viewer = null;
    vi.clearAllMocks();
});

describe("a Send's link", () => {
    it("reads the start, hours and people columns with the Send", async () => {
        await reason({});
        expect(findUnique.mock.calls[0]![0].select).toMatchObject(LINK_GUARD_SELECT);
    });

    linkGuardCases(reason, (who) => {
        viewer = who;
    });

    it("refuses before the password is tried or a view is counted", async () => {
        findUnique.mockResolvedValueOnce(
            row({ requireLogin: true, passwordHash: "h", maxAccessCount: 1 })
        );
        expect(await sends.accessSend("access-id", "guess", "198.51.100.7")).toEqual({
            ok: false,
            reason: "sign_in_required"
        });
        expect(verifyLinkPassword).not.toHaveBeenCalled();
        expect(updateMany).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });

    it("refuses a Bitwarden client, which has no session, with a 403 that says where it opens", async () => {
        findUnique.mockResolvedValueOnce(row({ allowedUsers: '["ana"]' }));
        const response = await api.accessSend(context());
        expect(response.status).toBe(403);
        expect(response.headers.get("x-polaris-send-refusal")).toBe("sign_in_required");
        expect(((await response.json()) as { message: string }).message).toMatch(/browser/);
    });

    it("tells the /vs page outside its hours apart from a refused address", async () => {
        const other = 1 << (new Date().getUTCDay() + 3) % 7;
        findUnique.mockResolvedValueOnce(
            row({
                linkSchedule: JSON.stringify({
                    days: other,
                    startMinute: null,
                    endMinute: null,
                    timeZone: "UTC"
                })
            })
        );
        const closed = await api.accessSend(context());
        expect(closed.headers.get("x-polaris-send-refusal")).toBe("outside_hours");

        findUnique.mockResolvedValueOnce(row({ allowedCidrs: '["10.0.0.0/8"]' }));
        const elsewhere = await api.accessSend(context());
        expect(elsewhere.status).toBe(403);
        expect(elsewhere.headers.get("x-polaris-send-refusal")).toBe("address");
    });

    it("stores the owner's start, hours and people from the Sends screen", async () => {
        updateMany.mockResolvedValueOnce({ count: 1 });
        const startsAt = new Date("2027-01-04T00:00:00Z");
        await sends.setSendRules("u", "send-1", {
            allowedCidrs: [],
            allowedCountries: [],
            allowedContinents: [],
            startsAt,
            schedule: { days: 62, startMinute: 540, endMinute: 1080, timeZone: "Europe/Madrid" },
            requireLogin: true,
            allowedUsers: ["ana"]
        });
        expect(updateMany.mock.calls[0]![0].data).toMatchObject({
            startsAt,
            requireLogin: true,
            allowedUsers: '["ana"]',
            linkSchedule: JSON.stringify({
                days: 62,
                startMinute: 540,
                endMinute: 1080,
                timeZone: "Europe/Madrid"
            })
        });
    });
});
