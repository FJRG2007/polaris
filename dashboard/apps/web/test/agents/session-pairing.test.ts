import { beforeEach, describe, expect, it, vi } from "vitest";

const rows: { id: string; identifier: string; value: string; expiresAt: Date }[] = [];
vi.mock("@polaris/db", () => ({
    prisma: {
        verification: {
            deleteMany: vi.fn(async ({ where }: { where: { id?: string } }) => {
                const before = rows.length;
                for (let at = rows.length - 1; at >= 0; at--) if (where.id === undefined || rows[at]!.id === where.id) rows.splice(at, 1);
                return { count: before - rows.length };
            }),
            create: vi.fn(async ({ data }: { data: { identifier: string; value: string; expiresAt: Date } }) => {
                rows.push({ id: `row-${rows.length + 1}`, ...data });
            }),
            findFirst: vi.fn(async ({ where }: { where: { identifier: string; expiresAt: { gt: Date } } }) =>
                rows.find((row) => row.identifier === where.identifier && row.expiresAt > where.expiresAt.gt) ?? null
            ),
            updateMany: vi.fn(async ({ where, data }: { where: { id: string; value: string }; data: { value: string } }) => {
                const row = rows.find((one) => one.id === where.id && one.value === where.value);
                if (row) row.value = data.value;
                return { count: row ? 1 : 0 };
            })
        }
    }
}));
const limit = { ok: true };
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: vi.fn(async () => limit) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example/" }));
const OWNER = "0190a5f2-2222-7000-8000-0000000000aa";
const OTHER = "0190a5f2-2222-7000-8000-0000000000bb";
const SESSION = "0190a5f2-2222-7000-8000-0000000000cc";
vi.mock("@/lib/agents/session-service", () => ({ sessionOwner: vi.fn(async (id: string) => (id === SESSION ? OWNER : null)) }));

const pairing = await import("@/lib/agents/session-pairing");

beforeEach(() => {
    rows.length = 0;
    limit.ok = true;
});

describe("session pairing", () => {
    it("opens a one-time link for the owner, storing only the code's hash", async () => {
        const opened = await pairing.openPairing(OWNER, SESSION);
        if (!opened || opened === "busy") throw new Error("not opened");
        expect(opened.code).toMatch(pairing.PAIRING_CODE);
        expect(opened.url).toBe(`https://polaris.example/continue/${opened.code}`);
        expect(rows[0]!.identifier).not.toContain(opened.code);
        expect(rows[0]!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(pairing.PAIRING_TTL_MS);
    });

    it("refuses a session the person does not own, and a person over the limit", async () => {
        expect(await pairing.openPairing(OTHER, SESSION)).toBeNull();
        limit.ok = false;
        expect(await pairing.openPairing(OWNER, SESSION)).toBe("busy");
    });

    it("is spent once, only by the person it was made for", async () => {
        const opened = (await pairing.openPairing(OWNER, SESSION)) as { code: string };
        expect(await pairing.spendPairing(opened.code, OTHER)).toBeNull();
        expect(await pairing.spendPairing(opened.code, OWNER)).toBe(SESSION);
        expect(await pairing.spendPairing(opened.code, OWNER)).toBeNull();
    });

    it("does not answer after it expires", async () => {
        const opened = (await pairing.openPairing(OWNER, SESSION)) as { code: string };
        rows[0]!.expiresAt = new Date(Date.now() - 1);
        expect(await pairing.readPairing(opened.code)).toBeNull();
        expect(await pairing.spendPairing(opened.code, OWNER)).toBeNull();
    });

    it("attaches the first signed-out phone only, and shows it to the owner", async () => {
        const opened = (await pairing.openPairing(OWNER, SESSION)) as { code: string };
        expect(await pairing.pairingState(opened.code, OWNER)).toEqual({ state: "waiting" });
        expect(await pairing.attachSignIn(opened.code, "ABCD-EFGH")).toBe(true);
        expect(await pairing.attachSignIn(opened.code, "WXYZ-1234")).toBe(false);
        expect(await pairing.pairingState(opened.code, OWNER)).toEqual({ state: "phone", userCode: "ABCD-EFGH" });
        expect(await pairing.pairingState(opened.code, OTHER)).toEqual({ state: "gone" });
    });

    it("rejects anything that is not a code without a lookup", async () => {
        expect(await pairing.readPairing("../../etc")).toBeNull();
        expect(pairing.readPairingValue("not json")).toBeNull();
    });
});
