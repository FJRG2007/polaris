/**
 * The NAS entry points that decide who reaches what: the page's data route,
 * the actions it calls, and the storage tick's Automation events.
 */

import type { UnasMetrics } from "@/lib/unifi-unas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnasBackupTask } from "@/lib/unifi-unas-control";

const NAS = "11111111-1111-4111-8111-111111111111";
const OWNER = "owner";

let user = { id: OWNER, isAdmin: false };
let lent: { id: string; capability: string; actions: string[]; counted: boolean }[] = [];
let storedKeys: string[] = [];
let listed: UnasBackupTask[] = [];

const spendGrant = vi.fn(async () => true);
const writeFanProfile = vi.fn(async () => undefined);
const runBackupTask = vi.fn(async () => undefined);
const emitAutomationEvent = vi.fn(async () => undefined);
const update = vi.fn(async ({ data }: { data: { nasAlertKeys: string[] } }) => {
    storedKeys = data.nasAlertKeys;
});

vi.mock("@polaris/db", () => ({
    prisma: {
        storageConnection: {
            findFirst: async ({ where }: { where: { id: string } }) =>
                where.id === NAS ? { id: NAS, name: "nas", ownerId: OWNER, placeId: null } : null,
            findUnique: async () => ({
                id: NAS,
                name: "nas",
                ownerId: OWNER,
                kind: "unifi-unas",
                nasAlertKeys: storedKeys
            }),
            update,
            updateMany: async () => ({ count: 1 })
        },
        place: { findUnique: async () => null }
    }
}));
vi.mock("@/lib/session", () => ({ requireUser: async () => user }));
vi.mock("@/lib/api-session", () => ({ apiUser: async () => user }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/access/grants", () => ({
    liveGrants: async () => lent.map((grant) => ({ ...grant, until: null })),
    spendGrant
}));
vi.mock("@/lib/audit-service", () => ({ recordAudit: async () => undefined }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/storage-service", () => ({ getUnasTarget: async () => ({ host: "nas.test" }) }));
vi.mock("@/lib/automations/outbox", () => ({ emitAutomationEvent }));
vi.mock("@/lib/unifi-unas", () => ({ fetchUnasMetrics: async () => metrics }));
vi.mock("@/lib/unifi-unas-control", async (original) => ({
    ...(await original<typeof import("@/lib/unifi-unas-control")>()),
    readFanProfile: async () => "balanced",
    writeFanProfile,
    listBackupTasks: async () => listed,
    runBackupTask
}));
vi.mock("@/lib/nas/nas-history", async (original) => ({
    ...(await original<typeof import("@/lib/nas/nas-history")>()),
    nasHistory: async () => [],
    recordNasSample: async () => undefined,
    pruneNasSamples: async () => undefined
}));

const metrics: UnasMetrics = {
    totalBytes: 1000,
    usedBytes: 950,
    pools: [
        {
            device: "md0",
            raidLevel: "raid5",
            raidState: "normal",
            membersExpected: 1,
            membersPresent: 1,
            usedBytes: 950,
            totalBytes: 1000
        }
    ] as unknown as UnasMetrics["pools"],
    disks: [
        {
            slot: 1,
            present: true,
            state: "normal",
            model: "Drive",
            serial: "SERIAL-1",
            type: null,
            sizeBytes: 1000,
            temperature: 40,
            healthy: true,
            rpm: null,
            powerOnHours: null
        }
    ],
    slotsTotal: 1,
    slotsPopulated: 1,
    health: "healthy",
    system: {
        name: "nas",
        model: "UNAS Pro",
        firmware: "4.1.7",
        cpuTemp: 50,
        cpuLoad: 0.1,
        memoryUsedBytes: 0,
        memoryTotalBytes: 0,
        uptimeSeconds: 0
    },
    raw: {}
};

const failedTask: UnasBackupTask = {
    id: "task-1",
    name: "Nightly",
    scheduleEnabled: false,
    nextRun: null,
    lastStatus: "failed",
    lastStartedAt: null,
    lastFinishedAt: null,
    errorCodes: ["E1"],
    remoteType: null
};

const route = await import("@/app/api/places/nas/[connectionId]/route");
const actions = await import("@/app/(app)/places/nas/actions");
const watch = await import("@/lib/nas/nas-watch");

function get(id: string) {
    return route.GET(new Request(`http://polaris.test/api/places/nas/${id}`), {
        params: Promise.resolve({ connectionId: id })
    });
}

function lend(capability: string, actionsLent: string[]) {
    user = { id: "visitor", isAdmin: false };
    lent = [{ id: `g-${capability}`, capability, actions: actionsLent, counted: true }];
}

beforeEach(() => {
    user = { id: OWNER, isAdmin: false };
    lent = [];
    storedKeys = [];
    listed = [failedTask];
    vi.clearAllMocks();
});

describe("the NAS data route", () => {
    it("is not there for somebody it was not lent to", async () => {
        user = { id: "stranger", isAdmin: false };
        expect((await get(NAS)).status).toBe(404);
        expect((await get("not-a-uuid")).status).toBe(404);
    });

    it("shows the owner the serials and a visitor none", async () => {
        const owned = await (await get(NAS)).json();
        expect(owned.status.value.disks[0].serial).toBe("SERIAL-1");
        lend("view", ["watch"]);
        const lentAnswer = await (await get(NAS)).json();
        expect(lentAnswer.status.value.disks[0].serial).toBeNull();
    });
});

describe("the NAS actions", () => {
    it("refuses a visitor the fan and the backup without the grant for them", async () => {
        lend("view", ["watch"]);
        expect(await actions.setNasFanAction(NAS, "quiet")).toEqual({
            ok: false,
            error: "notFound"
        });
        expect(await actions.runNasBackupAction(NAS, "task-1")).toEqual({
            ok: false,
            error: "notFound"
        });
        expect(writeFanProfile).not.toHaveBeenCalled();
        expect(runBackupTask).not.toHaveBeenCalled();
    });

    it("lets a fan grant set the fan, spending one use, and not run a backup", async () => {
        lend("control", ["fan"]);
        expect(await actions.setNasFanAction(NAS, "quiet")).toEqual({ ok: true });
        expect(writeFanProfile).toHaveBeenCalledWith({ host: "nas.test" }, "quiet");
        expect(spendGrant).toHaveBeenCalledTimes(1);
        expect((await actions.runNasBackupAction(NAS, "task-1")).ok).toBe(false);
    });

    it("runs only a task the NAS lists", async () => {
        lend("control", ["backup"]);
        expect(await actions.runNasBackupAction(NAS, "elsewhere")).toEqual({
            ok: false,
            error: "notFound"
        });
        expect(runBackupTask).not.toHaveBeenCalled();
        expect(spendGrant).not.toHaveBeenCalled();
        expect(await actions.runNasBackupAction(NAS, "task-1")).toEqual({ ok: true });
        expect(runBackupTask).toHaveBeenCalledWith({ host: "nas.test" }, "task-1");
        expect(spendGrant).toHaveBeenCalledTimes(1);
    });

    it("keeps the place to the owner, and spends nothing for the owner", async () => {
        expect(await actions.setNasFanAction(NAS, "cooling")).toEqual({ ok: true });
        expect(spendGrant).not.toHaveBeenCalled();
        lend("control", ["fan", "backup"]);
        expect(await actions.setNasPlaceAction(NAS, null)).toEqual({
            ok: false,
            error: "notFound"
        });
    });
});

describe("the NAS storage tick", () => {
    const names = () =>
        emitAutomationEvent.mock.calls
            .map((call) => (call as unknown[])[1])
            .map((input) => (input as { subjectKey: string }).subjectKey);

    it("sends each condition once while it lasts", async () => {
        await watch.watchNas(NAS, metrics, new Date(1), listed);
        expect(names().sort()).toEqual(["nas.backup-failed", "nas.pool-usage"]);
        await watch.watchNas(NAS, metrics, new Date(2), listed);
        expect(emitAutomationEvent).toHaveBeenCalledTimes(2);
    });

    it("keeps the backup alerts through a reading without the tasks", async () => {
        await watch.watchNas(NAS, metrics, new Date(1), listed);
        emitAutomationEvent.mockClear();
        await watch.watchNas(NAS, metrics, new Date(2), null);
        expect(storedKeys).toContain("backup:task-1");
        await watch.watchNas(NAS, metrics, new Date(3), listed);
        expect(emitAutomationEvent).not.toHaveBeenCalled();
    });

    it("waits for a second missed poll, then keeps what was standing", async () => {
        await watch.watchNas(NAS, metrics, new Date(1), listed);
        emitAutomationEvent.mockClear();
        await watch.watchNas(NAS, null, new Date(2), null);
        expect(emitAutomationEvent).not.toHaveBeenCalled();
        await watch.watchNas(NAS, null, new Date(3), null);
        expect(names()).toEqual(["nas.offline"]);
        expect(storedKeys).toEqual(["backup:task-1", "offline", "usage:md0"]);
        emitAutomationEvent.mockClear();
        await watch.watchNas(NAS, metrics, new Date(4), listed);
        expect(emitAutomationEvent).not.toHaveBeenCalled();
        expect(storedKeys).not.toContain("offline");
    });

    it("holds only what a reading cannot speak to", () => {
        const keys = ["backup:a", "overdue:b", "usage:md0", "offline"];
        expect(watch.heldKeys(keys, "full")).toEqual([]);
        expect(watch.heldKeys(keys, "no-tasks")).toEqual(["backup:a", "overdue:b"]);
        expect(watch.heldKeys(keys, "offline")).toEqual(["backup:a", "overdue:b", "usage:md0"]);
    });
});
