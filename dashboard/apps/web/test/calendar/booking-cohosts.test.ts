/**
 * A booking page handed to a co-host (`calendar.booking`). The co-host finds it
 * in their own list, marked with their level; at `view` they read it and its
 * bookings and change nothing; at `edit` they change how it books but never the
 * owner's calendars; duplicating and deleting stay with the owner, and deleting
 * takes every co-host's grant with it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Page = { id: string; ownerId: string; title: string; calendarId: string; conflictIds: string };

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    pages: [] as Page[],
    updates: [] as Record<string, unknown>[],
    dropped: [] as string[]
}));

function row(page: Page) {
    return {
        ...page,
        slug: `${page.id}-slug`,
        description: "",
        location: "",
        visibility: "link",
        durationMinutes: 30,
        slotMinutes: 30,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 0,
        maxPerDay: null,
        horizonDays: 30,
        timezone: "UTC",
        availability: "{}",
        questions: "[]",
        meetingLink: false,
        enabled: true,
        createdAt: new Date(0),
        updatedAt: new Date(0)
    };
}

vi.mock("@polaris/app-host", () => ({
    host: {
        accessGrants: {
            grantedSubjects: vi.fn(async () => new Map(state.granted)),
            dropGrantsFor: vi.fn(async (_subject: string, id: string) => {
                state.dropped.push(id);
            })
        }
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        calendarBookingPage: {
            findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
                if (typeof where.ownerId === "string")
                    return state.pages.filter((one) => one.ownerId === where.ownerId).map(row);
                const ids = (where.id as { in: string[] }).in;
                const not = (where.ownerId as { not: string }).not;
                return state.pages
                    .filter((one) => ids.includes(one.id) && one.ownerId !== not)
                    .map(row);
            }),
            findUnique: vi.fn(async ({ where }: { where: { id?: string; slug?: string } }) => {
                const found = state.pages.find(
                    (one) => one.id === where.id || `${one.id}-slug` === where.slug
                );
                return found ? row(found) : null;
            }),
            findFirst: vi.fn(async ({ where }: { where: { id: string; ownerId: string } }) => {
                const found = state.pages.find(
                    (one) => one.id === where.id && one.ownerId === where.ownerId
                );
                return found ? row(found) : null;
            }),
            update: vi.fn(
                async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
                    state.updates.push(data);
                    return { ...row(state.pages.find((one) => one.id === where.id)!), ...data };
                }
            ),
            delete: vi.fn(async () => undefined)
        },
        calendarBooking: {
            groupBy: vi.fn(async () => []),
            findMany: vi.fn(async () => [])
        }
    }
}));
vi.mock("@polaris-app/calendar/src/lib/i18n", () => ({
    calendarT: async () => (key: string) => key,
    calendarTFor: async () => (key: string) => key,
    calendarTIn: () => (key: string) => key,
    localeOf: async () => "en-US"
}));
vi.mock("@polaris-app/calendar/src/lib/instance-settings", () => ({
    readInstanceSettings: async () => ({ allowBooking: true })
}));
vi.mock("@polaris-app/calendar/src/lib/access", () => ({
    requireCalendar: vi.fn(async () => {
        throw new Error("calendar check reached");
    }),
    requireWritableCalendar: vi.fn(async () => {
        throw new Error("calendar check reached");
    }),
    reachOf: vi.fn(),
    reaches: vi.fn()
}));

const booking = await import("@polaris-app/calendar/src/lib/booking");

const owner = { id: "owner" } as Parameters<typeof booking.listBookingPages>[0];
const cohost = { id: "cohost" } as Parameters<typeof booking.listBookingPages>[0];

function input(overrides: Record<string, unknown> = {}) {
    return {
        title: "Consultation",
        description: "",
        location: "",
        visibility: "link",
        calendarId: "cohost-calendar",
        conflictIds: ["cohost-other"],
        durationMinutes: 45,
        slotMinutes: 30,
        bufferBefore: 0,
        bufferAfter: 0,
        noticeMinutes: 0,
        maxPerDay: null,
        horizonDays: 30,
        timezone: "UTC",
        availability: {},
        questions: [],
        meetingLink: false,
        enabled: true,
        ...overrides
    } as unknown as Parameters<typeof booking.updateBookingPage>[2];
}

describe("a booking page with a co-host", () => {
    beforeEach(() => {
        state.granted = new Map();
        state.updates = [];
        state.dropped = [];
        state.pages = [
            {
                id: "p1",
                ownerId: "owner",
                title: "Consultation",
                calendarId: "owner-calendar",
                conflictIds: JSON.stringify(["owner-other"])
            }
        ];
    });

    it("is in the co-host's list with their level, and not without a grant", async () => {
        expect(await booking.listBookingPages(cohost)).toEqual([]);
        state.granted = new Map([["p1", "view"]]);
        const list = await booking.listBookingPages(cohost);
        expect(list).toHaveLength(1);
        expect(list[0]).toMatchObject({ id: "p1", shared: "view" });
        expect((await booking.listBookingPages(owner))[0]?.shared).toBeUndefined();
    });

    it("opens with its bookings at view, and refuses a change", async () => {
        state.granted = new Map([["p1", "view"]]);
        await expect(booking.bookingPage(cohost, "p1")).resolves.toMatchObject({ shared: "view" });
        await expect(booking.listBookings(cohost, "p1")).resolves.toEqual([]);
        await expect(booking.updateBookingPage(cohost, "p1", input())).rejects.toThrow(
            "bookingPage.notFound"
        );
        expect(state.updates).toEqual([]);
    });

    it("changes how it books at edit, keeping the owner's calendars", async () => {
        state.granted = new Map([["p1", "edit"]]);
        const view = await booking.updateBookingPage(cohost, "p1", input());
        expect(view.shared).toBe("edit");
        expect(state.updates[0]).toMatchObject({
            durationMinutes: 45,
            calendarId: "owner-calendar",
            conflictIds: JSON.stringify(["owner-other"])
        });
    });

    it("leaves duplicating and deleting to the owner, and deleting drops its grants", async () => {
        state.granted = new Map([["p1", "edit"]]);
        await expect(booking.deleteBookingPage(cohost, "p1")).rejects.toThrow();
        await expect(booking.duplicateBookingPage(cohost, "p1")).rejects.toThrow();
        await booking.deleteBookingPage(owner, "p1");
        expect(state.dropped).toEqual(["p1"]);
    });

    it("is nobody's to read without a grant", async () => {
        await expect(booking.bookingPage(cohost, "p1")).rejects.toThrow("bookingPage.notFound");
        await expect(booking.listBookings(cohost, "p1")).rejects.toThrow("bookingPage.notFound");
    });
});
