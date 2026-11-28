/**
 * Nobody can be their own successor, whichever of their identifiers is typed.
 *
 * The owner typed one of their own additional addresses, was told no account
 * matched, and could still ask for a code and press "Add successor". The lookup
 * now says it is them, and neither a code nor the add goes anywhere for an
 * account that is not somebody else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ME = "user-me";
const HEIR = "user-heir";

const userFindUnique = vi.fn();
const userFindFirst = vi.fn();
const userFindMany = vi.fn();
const upsert = vi.fn(async (_args: unknown) => ({}));
const sendStepUpCode = vi.fn(async () => ({}));
const proveStepUp = vi.fn(async () => ({}));

vi.mock("@/lib/people-search", () => ({
    // Whole username or address, the way the shared rule finds one.
    resolveNamedAccount: async (_viewer: unknown, identifier: string) => {
        const needle = identifier.trim().toLowerCase().replace(/^@/, "");
        return (
            (await userFindFirst({ needle })) as { id: string; name: string; username: string | null } | null
        );
    },
    findableBy: async (_viewer: string, ids: readonly string[]) => new Set(ids)
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: userFindUnique, findFirst: userFindFirst, findMany: userFindMany },
        accountSuccessor: {
            upsert,
            findUnique: async () => ({
                acknowledgedAt: new Date("2026-01-01T00:00:00.000Z"),
                successor: { id: HEIR, name: "Ana Garcia", email: "ana@example.test", username: "ana" }
            }),
            deleteMany: vi.fn()
        }
    }
}));
vi.mock("@/lib/privacy-service", () => ({ contactLines: async () => new Map() }));
vi.mock("@/lib/session", () => ({ requireUser: async () => ({ id: ME, sessionId: "s1" }) }));
vi.mock("@/lib/device-grace", () => ({ newDeviceRefusal: async () => null }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/app/(app)/account/security/action-messages", () => ({
    localized: async (result: unknown) => result,
    firstIssue: async () => ({ error: "check" })
}));
vi.mock("@/lib/step-up", async (original) => ({
    ...(await original<typeof import("@/lib/step-up")>()),
    proveStepUp,
    sendStepUpCode,
    stepUpOptions: vi.fn()
}));
vi.mock("@/lib/step-up-grant", () => ({ grantStepUp: vi.fn(), stepUpRemainingMs: vi.fn(), STEP_UP_PURPOSES: [] }));
vi.mock("@/lib/auth", () => ({ auth: {} }));
vi.mock("@polaris/auth", () => ({}));

const { lookupSuccessor } = await import("../../src/lib/successor-service");
const { lookupSuccessorAction, setSuccessorAction } = await import(
    "../../src/app/(app)/account/security/successor-actions"
);
const { sendStepUpCodeAction } = await import("../../src/app/(app)/account/step-up-actions");

const ownAccount = {
    email: "person@example.test",
    username: "person",
    emails: [{ email: "second@example.test" }, { email: "unproved@example.test" }]
};

beforeEach(() => {
    vi.clearAllMocks();
    userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
        args.where.id === ME ? ownAccount : args.where.id === HEIR ? { id: HEIR } : null
    );
    userFindFirst.mockResolvedValue(null);
    userFindMany.mockResolvedValue([]);
});

describe("the lookup", () => {
    it.each(["person@example.test", "Second@Example.test", "unproved@example.test", "@Person", "person"])(
        "says it is you for your own identifier %s",
        async (typed) => {
            expect(await lookupSuccessor(ME, typed)).toEqual({ kind: "self" });
        }
    );

    it("says it is you when the account found is yours", async () => {
        userFindFirst.mockResolvedValue({ id: ME, name: "Me", username: "me2" });
        expect(await lookupSuccessor(ME, "me2")).toEqual({ kind: "self" });
    });

    it("says it is you for your own name when nobody else carries it", async () => {
        userFindMany.mockResolvedValue([{ id: ME, name: "Pat Doe", username: null }]);
        expect(await lookupSuccessor(ME, "pat doe")).toEqual({ kind: "self" });
    });

    it("finds nobody for something that matches nobody", async () => {
        expect(await lookupSuccessor(ME, "nobody@example.test")).toEqual({ kind: "none" });
    });

    it("returns another account by name and handle only, never the address typed", async () => {
        userFindFirst.mockResolvedValue({ id: HEIR, name: "Ana Garcia", username: "ana" });
        const found = await lookupSuccessor(ME, "ana.secondary@example.test");
        expect(found).toEqual({
            kind: "match",
            person: { userId: HEIR, name: "Ana Garcia", username: "ana" }
        });
        expect(JSON.stringify(found)).not.toContain("example.test");
    });

    it("refuses to guess between two people with one name", async () => {
        userFindMany.mockResolvedValue([
            { id: "a", name: "Ana Garcia", username: null },
            { id: "b", name: "Ana Garcia", username: null }
        ]);
        expect(await lookupSuccessor(ME, "Ana Garcia")).toEqual({ kind: "ambiguous" });
    });

    it("is reachable through the action for the signed-in account", async () => {
        expect(await lookupSuccessorAction("second@example.test")).toEqual({ kind: "self" });
    });
});

describe("sending a code to name a successor", () => {
    it("sends nothing for your own id", async () => {
        const result = await sendStepUpCodeAction(`account-successor-set:${ME}`, "email");
        expect(result.error).toBeTruthy();
        expect(sendStepUpCode).not.toHaveBeenCalled();
    });

    it("sends nothing for an account that does not exist", async () => {
        const result = await sendStepUpCodeAction("account-successor-set:ghost", "email");
        expect(result.error).toBeTruthy();
        expect(sendStepUpCode).not.toHaveBeenCalled();
    });

    it("sends for somebody else", async () => {
        const result = await sendStepUpCodeAction(`account-successor-set:${HEIR}`, "email");
        expect(result.error).toBeUndefined();
        expect(sendStepUpCode).toHaveBeenCalledOnce();
    });

    it("leaves every other purpose alone", async () => {
        await sendStepUpCodeAction("org-delete:abc", "email");
        expect(sendStepUpCode).toHaveBeenCalledOnce();
    });
});

describe("the add-successor action", () => {
    const proof = { proof: "email", code: "123456" };

    it("rejects the caller's own id before checking the proof", async () => {
        const result = await setSuccessorAction({ identifier: "person@example.test", userId: ME, proof });
        expect(result.error).toBeTruthy();
        expect(proveStepUp).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
    });

    it("rejects the caller's own secondary address even with another account's id", async () => {
        const result = await setSuccessorAction({
            identifier: "second@example.test",
            userId: HEIR,
            proof
        });
        expect(result.error).toBeTruthy();
        expect(proveStepUp).not.toHaveBeenCalled();
        expect(upsert).not.toHaveBeenCalled();
    });

    it("rejects an identifier that matches nobody", async () => {
        const result = await setSuccessorAction({ identifier: "nobody@example.test", userId: HEIR, proof });
        expect(result.error).toBeTruthy();
        expect(upsert).not.toHaveBeenCalled();
    });

    it("rejects an id the typed text did not resolve to", async () => {
        userFindFirst.mockResolvedValue({ id: HEIR, name: "Ana Garcia", username: "ana" });
        const result = await setSuccessorAction({ identifier: "ana", userId: "someone-else", proof });
        expect(result.error).toBeTruthy();
        expect(upsert).not.toHaveBeenCalled();
    });

    it("names another account after the proof, against the picked account's purpose", async () => {
        userFindFirst.mockResolvedValue({ id: HEIR, name: "Ana Garcia", username: "ana" });
        const result = await setSuccessorAction({ identifier: "ana", userId: HEIR, proof });
        expect(result.error).toBeUndefined();
        expect(proveStepUp).toHaveBeenCalledWith(ME, `account-successor-set:${HEIR}`, proof);
        expect(upsert).toHaveBeenCalledOnce();
    });
});
