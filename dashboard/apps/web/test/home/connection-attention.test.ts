/**
 * A connection that stopped for a reason only its owner can fix.
 *
 * Tuya's "IoT Core subscription has expired" used to arrive as an ordinary
 * refused request: the press failed, the account stayed "ok", and nobody was
 * told. What is checked here is the whole chain - their code becomes its own
 * sort, the sort marks the account, and the house's owner hears about it once
 * per connection and cause, from a press or a scheduled read alike.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const notified: { event: string; title: string; body: string; dedupKey?: string | null }[] = [];
let stored: { id: string; status: string; statusNote: string | null };

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_MASTER_KEY: "test-key" }) }));
vi.mock("@polaris/app-host", () => ({
    host: {
        notificationsPreferences: { ruleFor: async () => ({ inapp: true }) },
        notificationsDispatch: {
            notify: async (input: (typeof notified)[number]) => {
                notified.push(input);
            }
        },
        i18nLocaleService: { getUserLocale: async () => "en-US" }
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        installedApp: { findFirst: async () => ({ ownerId: "owner-1" }) },
        placeDeviceAccount: {
            findFirst: async () => ({
                installedAppId: "install-1",
                label: "Lirio",
                statusNote: stored.statusNote
            }),
            updateMany: async (args: {
                where: { id: string; status?: { not: string } };
                data: { status?: string; statusNote?: string | null };
            }) => {
                if (args.where.status && stored.status === args.where.status.not)
                    return { count: 0 };
                if (args.data.status !== undefined) stored.status = args.data.status;
                if (args.data.statusNote !== undefined) stored.statusNote = args.data.statusNote;
                return { count: 1 };
            }
        }
    }
}));

const { accountFailed, markSynced } = await import("@polaris-app/places/src/lib/device-accounts");
const { DriverError } = await import("@polaris-app/places/src/lib/drivers/contract");
const { TUYA_LAPSED, TuyaError, tuyaToken } =
    await import("@polaris-app/places/src/lib/integrations/tuya-api");
const { tuyaSpeaking } = await import("@polaris-app/places/src/lib/drivers/tuya-vocabulary");
const { placesRefusalText } = await import("@polaris-app/places/src/lib/refusal-text");
const { placesCatalogs } = await import("@polaris-app/places/messages");

beforeEach(() => {
    notified.length = 0;
    stored = { id: "account-1", status: "ok", statusNote: null };
});

function refusing(code: number, msg: string) {
    vi.stubGlobal(
        "fetch",
        async () => new Response(JSON.stringify({ success: false, code, msg }), { status: 200 })
    );
}

describe("what Tuya's code means", () => {
    const credentials = { accessId: "access-id", accessSecret: "secret", region: "eu" };

    it.each([28841001, 28841002, 28841003, 28841004, 28841101, 28841102, 28841104, 28841106])(
        "reads %i as a plan that ran out, in a sentence that says where to fix it",
        async (code) => {
            refusing(
                code,
                "No permissions. Your subscription to cloud development plan has expired"
            );
            const caught = await tuyaToken(credentials).catch((error: unknown) => error);
            expect(caught).toBeInstanceOf(TuyaError);
            expect((caught as InstanceType<typeof TuyaError>).kind).toBe("lapsed");
            expect((caught as Error).message).toBe(TUYA_LAPSED);
            vi.unstubAllGlobals();
        }
    );

    it("still reads a revoked token as refused keys, not a lapsed plan", async () => {
        refusing(1011, "token invalid");
        const caught = await tuyaToken(credentials).catch((error: unknown) => error);
        expect((caught as InstanceType<typeof TuyaError>).kind).toBe("unauthorized");
        vi.unstubAllGlobals();
    });

    it("keeps the sort when it becomes a driver's refusal", async () => {
        const caught = await tuyaSpeaking(async () => {
            throw new TuyaError(TUYA_LAPSED, "lapsed");
        }).catch((error: unknown) => error);
        expect(caught).toBeInstanceOf(DriverError);
        expect((caught as InstanceType<typeof DriverError>).kind).toBe("lapsed");
    });

    it("says it in Spanish to a Spanish reader", () => {
        const t = placesCatalogs.translator("es-ES", "places");
        expect(placesRefusalText(t, TUYA_LAPSED)).toContain("Smart Life");
        expect(placesRefusalText(t, TUYA_LAPSED)).not.toBe(TUYA_LAPSED);
    });
});

describe("the account and the bell", () => {
    it("marks a lapsed plan and tells the owner once, however many presses fail", async () => {
        const lapsed = new DriverError(TUYA_LAPSED, "lapsed");
        await accountFailed("account-1", lapsed, true);
        await accountFailed("account-1", lapsed, true);
        await accountFailed("account-1", lapsed);
        expect(stored.status).toBe("lapsed");
        expect(notified).toHaveLength(1);
        expect(notified[0]).toMatchObject({
            event: "places.connection",
            title: "Lirio stopped working",
            body: TUYA_LAPSED,
            dedupKey: "places.connection:account-1:lapsed"
        });
    });

    it("tells again once it worked in between", async () => {
        const lapsed = new DriverError(TUYA_LAPSED, "lapsed");
        await accountFailed("account-1", lapsed);
        await markSynced("account-1");
        await accountFailed("account-1", lapsed);
        expect(notified).toHaveLength(2);
    });

    it("tells again for a different cause on the same connection", async () => {
        await accountFailed("account-1", new DriverError(TUYA_LAPSED, "lapsed"));
        await accountFailed(
            "account-1",
            new DriverError("Tuya refused the request.", "unauthorized")
        );
        expect(notified.map((entry) => entry.dedupKey)).toEqual([
            "places.connection:account-1:lapsed",
            "places.connection:account-1:unauthorized"
        ]);
    });

    it("leaves the account alone when one press goes unanswered", async () => {
        await accountFailed(
            "account-1",
            new DriverError("Tuya could not be reached.", "unreachable"),
            true
        );
        expect(stored.status).toBe("ok");
        expect(notified).toHaveLength(0);
    });

    it("marks a read that could not get through without ringing anyone", async () => {
        await accountFailed(
            "account-1",
            new DriverError("Tuya could not be reached.", "unreachable")
        );
        expect(stored.status).toBe("unreachable");
        expect(notified).toHaveLength(0);
    });
});
