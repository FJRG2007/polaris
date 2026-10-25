/**
 * Where mail, Drive, Calendar and game servers say what happened: each sends
 * its event with a payload that matches the core shape, and only to runners
 * who may see the thing. The emitter itself is mocked at its boundary.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type MayReceive = (runner: { id: string; isAdmin: boolean }) => Promise<boolean>;
type Emit = (
    name: string,
    payload: unknown,
    options: { key: string; mayReceive: MayReceive }
) => Promise<boolean>;

const sent: { name: string; payload: unknown; key: string; may: MayReceive }[] = [];
const emit = vi.fn<Emit>(async (name, payload, options) => {
    sent.push({ name, payload, key: options.key, may: options.mayReceive });
    return true;
});
const canRead = vi.fn(async () => true);
const authorize = vi.fn(async (): Promise<void> => undefined);
const access = vi.fn(async (): Promise<unknown> => ({ ownerId: "owner" }));
const listening = vi.fn(async () => true);
const reach = vi.fn(async () => new Map([["cal-1", "read"]]));

vi.mock("@/lib/automations/app-events", () => ({
    emitAppEvent: (...args: Parameters<Emit>) => emit(...args),
    anyListening: () => listening()
}));
vi.mock("@/lib/session", () => ({ sessionCan: () => canRead() }));
vi.mock("@/lib/drive-authz", () => ({ authorizeDrive: () => authorize() }));
vi.mock("@/lib/resource-access", () => ({ resourceAccess: () => access() }));
vi.mock("@/lib/apps/install-access", () => ({ installRef: (id: string) => ({ id }) }));
vi.mock("@/lib/apps/catalog", () => ({ isGameServerApp: (id: string) => id === "minecraft" }));
vi.mock("@/lib/apps/install-service", () => ({
    getInstalledApp: async () => ({ name: "Survival", catalogId: "minecraft" })
}));
vi.mock("@polaris/db", () => ({
    prisma: { installedApp: { findUnique: async () => ({ ownerId: "owner" }) } }
}));
/** Every app-host area the modules reach for, as a stand-in; the ones under test are real. */
function areas(known: Record<string, unknown>): Record<string, unknown> {
    const stub = new Proxy({}, { get: () => async () => undefined });
    return new Proxy(known, { get: (target, area: string) => target[area] ?? stub });
}

vi.mock("@polaris/app-host", () => ({
    host: areas({
        automations: {
            emitAppEvent: (...args: Parameters<Emit>) => emit(...args),
            anyListening: () => listening(),
            announceGameServerEvent: async (...args: unknown[]) => {
                const events = await import("@/lib/automations/game-server-events");
                const announce = events.announceGameServerEvent as (
                    ...a: unknown[]
                ) => Promise<boolean>;
                return announce(...args);
            }
        }
    })
}));
vi.mock("../../../calendar/src/lib/access", async (load) => ({
    ...(await load<object>()),
    reachOf: () => reach()
}));

const runner = { id: "u-1", isAdmin: false };
const INSTALL = "4b7f8a43-6a1f-4bd0-9a5d-0d3f5d0c1b11";

function matches(name: string, payload: unknown): boolean {
    return core.isAppEventName(name) && core.parseAppEventPayload(name, payload) !== null;
}

beforeEach(() => {
    sent.length = 0;
    vi.clearAllMocks();
});

describe("mail received", () => {
    it("sends the message with its sender, only to the mailbox owner", async () => {
        const { announceMail } = await import("@/lib/automations/mail-events");
        await announceMail({
            messageId: "msg-1",
            account: { id: "acc-1", userId: "u-1", address: "me@example.test" },
            from: [{ name: "Fixture Sender", address: "sender@example.test" }],
            subject: "Invoice",
            snippet: "Attached"
        });
        expect(sent[0]!.name).toBe("mail.received");
        expect(sent[0]!.payload).toEqual({
            messageId: "msg-1",
            accountId: "acc-1",
            mailbox: "me@example.test",
            from: "sender@example.test",
            fromName: "Fixture Sender",
            subject: "Invoice",
            snippet: "Attached"
        });
        expect(matches(sent[0]!.name, sent[0]!.payload)).toBe(true);
        expect(await sent[0]!.may(runner)).toBe(true);
        expect(await sent[0]!.may({ id: "u-2", isAdmin: true })).toBe(false);
    });
});

describe("Drive file uploaded", () => {
    it("sends the file, only to runners who may read it", async () => {
        const { announceUpload } = await import("@/lib/automations/drive-events");
        await announceUpload({
            connectionId: "conn-1",
            path: "Reports/q3.pdf",
            size: 1024n,
            uploaderId: "u-1"
        });
        expect(sent[0]!.name).toBe("drive.file-uploaded");
        expect(sent[0]!.payload).toEqual({
            connectionId: "conn-1",
            path: "Reports/q3.pdf",
            name: "q3.pdf",
            size: 1024,
            uploaderId: "u-1"
        });
        expect(matches(sent[0]!.name, sent[0]!.payload)).toBe(true);
        expect(await sent[0]!.may(runner)).toBe(true);
        // A refusal throws, which the emitter reads as "may not receive".
        authorize.mockRejectedValueOnce(new Error("forbidden"));
        await expect(sent[0]!.may(runner)).rejects.toThrow();
        canRead.mockResolvedValueOnce(false);
        expect(await sent[0]!.may(runner)).toBe(false);
    });
});

describe("game servers", () => {
    it("says a crash loop with its restarts and cause", async () => {
        const { announceGameServerEvent } = await import("@/lib/automations/game-server-events");
        await announceGameServerEvent(
            "owner",
            INSTALL,
            "game-server.crashed",
            { restarts: 5, cause: "OutOfMemoryError" },
            "crash:1"
        );
        expect(sent[0]).toMatchObject({
            name: "game-server.crashed",
            key: `${INSTALL}:crash:1`,
            payload: {
                installId: INSTALL,
                name: "Survival",
                game: "minecraft",
                restarts: 5,
                cause: "OutOfMemoryError"
            }
        });
        expect(matches(sent[0]!.name, sent[0]!.payload)).toBe(true);
        access.mockResolvedValueOnce(null);
        expect(await sent[0]!.may(runner)).toBe(false);
    });

    it("says each player who arrived, once per player", async () => {
        const { announceArrivals } =
            await import("../../../game-servers/src/lib/games-activity-service");
        await announceArrivals(
            INSTALL,
            [
                { name: "FixturePlayerA", id: null },
                { name: "FixturePlayerB", id: null }
            ],
            new Date(60_000 * 10)
        );
        expect(sent.map((one) => one.name)).toEqual([
            "game-server.player-joined",
            "game-server.player-joined"
        ]);
        expect(sent[0]!.payload).toMatchObject({ player: "FixturePlayerA", installId: INSTALL });
        expect(sent[1]!.key).toBe(`${INSTALL}:join:FixturePlayerB:10`);
        expect(sent.every((one) => matches(one.name, one.payload))).toBe(true);
    });

    it("asks nothing more when nobody listens for a player joining", async () => {
        listening.mockResolvedValueOnce(false);
        const { announceArrivals } =
            await import("../../../game-servers/src/lib/games-activity-service");
        await announceArrivals(INSTALL, [{ name: "FixturePlayerA", id: null }], new Date());
        expect(sent).toEqual([]);
    });
});

describe("calendar event starting soon", () => {
    const calendar = { id: "cal-1", name: "Team", ownerId: "owner", kind: "user", trashedAt: null };
    const item = (classification: string) =>
        ({
            component: "VEVENT",
            master: { summary: "Standup", classification, start: { utc: new Date(0) } },
            overrides: []
        }) as never;

    it("sends the occurrence when its alarm goes off", async () => {
        const { announceStarting } = await import("../../../calendar/src/lib/reminders");
        const at = new Date("2026-10-26T09:00:00.000Z");
        await announceStarting("obj-1", item("PUBLIC"), at, calendar, "obj-1:x");
        expect(sent[0]!.name).toBe("calendar.event-starting");
        expect(sent[0]!.payload).toEqual({
            eventId: "obj-1",
            calendarId: "cal-1",
            calendar: "Team",
            title: "Standup",
            startsAt: "2026-10-26T09:00:00.000Z",
            allDay: false
        });
        expect(matches(sent[0]!.name, sent[0]!.payload)).toBe(true);
        expect(await sent[0]!.may(runner)).toBe(true);
    });

    it("keeps a private event from a runner who only reads the calendar", async () => {
        const { announceStarting } = await import("../../../calendar/src/lib/reminders");
        await announceStarting("obj-1", item("PRIVATE"), new Date(), calendar, "obj-1:y");
        expect(await sent[0]!.may(runner)).toBe(false);
        reach.mockResolvedValueOnce(new Map([["cal-1", "write"]]));
        expect(await sent[0]!.may(runner)).toBe(true);
    });
});
