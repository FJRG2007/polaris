/**
 * A UPS plugged in by USB is watched by itself, as a NUT install picks one up:
 * nobody has to find it in a list and press Add. One somebody removed stays
 * removed - offered again, never added back on its own.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const LOCAL = "00000000-0000-4000-8000-000000000001";
type Row = Record<string, unknown> & { id: string };
const rows: Row[] = [];
const settings = new Map<string, string>();

vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
vi.mock("@polaris/db", () => ({
    prisma: {
        ups: {
            findMany: async ({
                where,
                take
            }: {
                where?: { connection?: string; deviceId?: { in: string[] } };
                take?: number;
            } = {}) =>
                rows
                    .filter(
                        (row) =>
                            (!where?.connection || row.connection === where.connection) &&
                            (!where?.deviceId || where.deviceId.in.includes(row.deviceId as string))
                    )
                    .slice(0, take),
            findUnique: async ({ where }: { where: { id: string } }) =>
                rows.find((row) => row.id === where.id) ?? null,
            create: async ({ data }: { data: Record<string, unknown> }) => {
                const row = {
                    id: `ups-${rows.length + 1}`,
                    createdAt: new Date(),
                    protectedMachineIds: [],
                    notifyKinds: [],
                    reportSchedule: "off",
                    variableMap: null,
                    ...data
                };
                rows.push(row);
                return row;
            },
            deleteMany: async ({ where }: { where: { id: string } }) => {
                const at = rows.findIndex((row) => row.id === where.id);
                if (at < 0) return { count: 0 };
                rows.splice(at, 1);
                return { count: 1 };
            }
        }
    }
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async (key: string) => settings.get(key) ?? null,
    setSetting: async (key: string, value: string | null) => {
        if (value === null) settings.delete(key);
        else settings.set(key, value);
    }
}));

const ups = await import("@/lib/ups/ups-service");

const plugged =
    (...ids: string[]) =>
    async () =>
        ({
            available: true,
            devices: ids.map((id) => ({
                device: {
                    id,
                    manufacturer: "APC",
                    product: "Back-UPS",
                    vendorId: "051d",
                    productId: "0002",
                    serial: id
                }
            }))
        }) as never;

beforeEach(() => {
    rows.length = 0;
    settings.clear();
});

describe("a UPS on USB", () => {
    it("is added by itself, once, however many look at the same moment", async () => {
        const listUsb = plugged("usb-apc-1");
        const [first, second] = await Promise.all([ups.adoptUsb(listUsb), ups.adoptUsb(listUsb)]);
        expect([first, second]).toEqual([1, 1]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            connection: "usb",
            machineId: LOCAL,
            deviceId: "usb-apc-1",
            name: "APC Back-UPS"
        });
        expect(await ups.adoptUsb(listUsb)).toBe(0);
    });

    it("stays removed once somebody removes it, and is offered instead", async () => {
        const listUsb = plugged("usb-apc-1");
        await ups.adoptUsb(listUsb);
        expect(await ups.removeUps(rows[0]!.id)).toBe(true);
        expect(await ups.adoptUsb(listUsb)).toBe(0);
        expect(rows).toHaveLength(0);
        const offers = await ups.dismissedOffers(await ups.usbOffers([], listUsb));
        expect(offers).toMatchObject({ state: "ok", offers: [{ deviceId: "usb-apc-1" }] });
    });

    it("is watched by itself again once added back by hand", async () => {
        const listUsb = plugged("usb-apc-1");
        await ups.adoptUsb(listUsb);
        await ups.removeUps(rows[0]!.id);
        await ups.createUps({
            connection: "usb",
            name: "Desk",
            machineId: LOCAL,
            deviceId: "usb-apc-1"
        });
        expect(settings.size).toBe(0);
        await ups.removeUps(rows[0]!.id);
        expect(await ups.adoptUsb(listUsb)).toBe(0);
    });

    it("is not added twice when hundreds of others are watched", async () => {
        for (let at = 0; at < 250; at += 1)
            rows.push({
                id: `nut-${at}`,
                connection: "nut",
                createdAt: new Date(),
                protectedMachineIds: [],
                notifyKinds: [],
                reportSchedule: "off",
                variableMap: null
            });
        const listUsb = plugged("usb-apc-1");
        expect(await ups.adoptUsb(listUsb)).toBe(1);
        expect(await ups.adoptUsb(listUsb)).toBe(0);
        expect(rows.filter((row) => row.connection === "usb")).toHaveLength(1);
    });

    it("keeps every removal when several are removed at once", async () => {
        const listUsb = plugged("usb-apc-1", "usb-apc-2", "usb-apc-3");
        await ups.adoptUsb(listUsb);
        await Promise.all(rows.map((row) => row.id).map((id) => ups.removeUps(id)));
        expect(await ups.adoptUsb(listUsb)).toBe(0);
        expect(rows).toHaveLength(0);
    });

    it("does not count a removal that did not happen", async () => {
        expect(await ups.removeUps("missing")).toBe(false);
        expect(settings.size).toBe(0);
    });

    it("offers nothing that is added by itself", async () => {
        const offers = await ups.dismissedOffers(await ups.usbOffers([], plugged("usb-apc-1")));
        expect(offers).toEqual({ state: "ok", offers: [] });
    });

    it("adds nothing when this edition has no daemon to ask", async () => {
        expect(
            await ups.adoptUsb(async () => {
                throw new Error("no daemon");
            })
        ).toBe(0);
        expect(rows).toHaveLength(0);
    });

    it("reads a stored list that no longer parses as nothing removed", async () => {
        settings.set("ups.usb.dismissed", "{oops");
        expect(await ups.adoptUsb(plugged("usb-apc-1"))).toBe(1);
    });
});
