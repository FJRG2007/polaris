/**
 * Spending VirusTotal's requests must not get a file past the scan.
 *
 * A drop point's link is public, so anybody can send throwaway files until the
 * budget is gone and then the one that matters. That file is kept, as a scanner
 * outage always kept it, but it stays owed a scan, and the configured action is
 * still applied to it when the requests come back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetLookupBudget, takeLookup } from "@/lib/reputation-budget";

interface Row {
    id: string;
    submissionId: string | null;
    connectionId: string | null;
    sha256: string | null;
    verdict: string;
    action?: string;
    createdAt: Date;
    updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const state = vi.hoisted(() => ({
    scans: [] as Row[],
    submissions: new Map<string, { status: string; storedPath?: string }>(),
    deleted: [] as string[],
    notices: [] as { event: string }[],
    onDetection: "block"
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        fileScan: {
            create: async ({ data }: { data: Partial<Row> }) => {
                const now = new Date();
                state.scans.push({
                    id: `scan-${state.scans.length}`,
                    submissionId: null,
                    connectionId: null,
                    sha256: null,
                    verdict: "pending",
                    createdAt: now,
                    updatedAt: now,
                    ...data
                });
            },
            findMany: async ({ where }: { where: { updatedAt: { lt: Date } } }) =>
                state.scans.filter(
                    (scan) => scan.verdict === "pending" && scan.updatedAt < where.updatedAt.lt
                ),
            update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
                Object.assign(state.scans.find((scan) => scan.id === where.id) ?? {}, data);
            },
            deleteMany: async ({ where }: { where: { id: string } }) => {
                state.scans = state.scans.filter((scan) => scan.id !== where.id);
            }
        },
        fileRequestSubmission: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                state.submissions.has(where.id)
                    ? {
                          fileName: "report.pdf",
                          storedPath: "drop/report.pdf",
                          size: 5n,
                          request: { ownerId: "owner", title: "Inbox" }
                      }
                    : null,
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string };
                data: { status: string };
            }) => {
                const row = state.submissions.get(where.id);
                if (row) Object.assign(row, data);
            }
        }
    }
}));

const file = () =>
    new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
            controller.close();
        }
    });

const driver = {
    readStream: async () => file(),
    delete: async (path: string) => void state.deleted.push(path),
    mkdir: async () => undefined,
    move: async () => undefined,
    dispose: async () => undefined
};

vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: async () => driver }));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({ enabled: true, config: {} }),
    getIntegrationSecret: async () => "key"
}));
vi.mock("@/lib/integrations/registry", () => ({
    readVirusTotalConfig: () => ({ scanDropPoints: true, onDetection: state.onDetection })
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (notice: { event: string }) => void state.notices.push(notice)
}));
vi.mock("@/lib/notifications/notice-words", () => ({
    wordsFor: async () => (key: string) => key
}));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));
vi.mock("@/lib/setting-store", () => {
    const settings = new Map<string, string>();
    return {
        getSetting: async (key: string) => settings.get(key) ?? null,
        setSetting: async (key: string, value: string | null) => {
            if (value === null) settings.delete(key);
            else settings.set(key, value);
        },
        swapSetting: async (key: string, _expected: string | null, value: string) => {
            settings.set(key, value);
            return true;
        }
    };
});
vi.mock("@/lib/connections/attention", () => ({
    recordConnectionFailure: async () => true,
    clearConnectionFailure: async () => true
}));

const { finishPendingScans, scanDropPointUpload } = await import("@/lib/scan-service");
const { uploadAndScan } = await import("@/lib/integrations/virustotal");

const upload = () =>
    scanDropPointUpload({
        driver: driver as never,
        connectionId: "connection",
        storedPath: "drop/.staged",
        fileName: "report.pdf",
        ownerId: "owner",
        dropPointTitle: "Inbox",
        submissionId: "submission",
        size: 5
    });

/** What a run of throwaway files leaves behind. */
function spendTheBudget(): void {
    while (takeLookup("virustotal", 0.75));
}

/** The upload's own attempt is a while ago, so the sweep picks it up. */
function age(by: number): void {
    for (const scan of state.scans) {
        scan.createdAt = new Date(scan.createdAt.getTime() - by);
        scan.updatedAt = new Date(scan.updatedAt.getTime() - by);
    }
}

const pending = () => state.scans.filter((scan) => scan.verdict === "pending");
const malicious = new Response(
    JSON.stringify({ data: { attributes: { last_analysis_stats: { malicious: 9 } } } })
);

describe("a file that arrives after the budget is spent", () => {
    const answers = vi.fn<(url: string) => Promise<Response>>();

    beforeEach(() => {
        resetLookupBudget();
        state.scans = [];
        state.submissions = new Map([["submission", { status: "stored" }]]);
        state.deleted = [];
        state.notices = [];
        state.onDetection = "block";
        answers.mockReset();
        answers.mockImplementation(async () => malicious.clone());
        vi.stubGlobal("fetch", (url: string) => answers(url));
    });

    it("is kept for now and owed a scan, without bothering the owner", async () => {
        spendTheBudget();
        expect(await upload()).toMatchObject({ blocked: false, action: "none" });
        expect(pending()).toHaveLength(1);
        expect(answers).not.toHaveBeenCalled();
        expect(state.notices).toEqual([]);
    });

    it("is blocked when the requests come back", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(state.deleted).toEqual(["drop/report.pdf"]);
        expect(state.submissions.get("submission")?.status).toBe("blocked");
        expect(pending()).toEqual([]);
        expect(state.scans[0]).toMatchObject({ verdict: "malicious", action: "blocked" });
        expect(state.notices).toMatchObject([{ event: "scan.detection" }]);
    });

    it("waits without sending anything while they are still gone", async () => {
        spendTheBudget();
        await upload();
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(answers).not.toHaveBeenCalled();
        expect(pending()).toHaveLength(1);
    });

    it("is not asked about twice in the same minute", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();

        await finishPendingScans();

        expect(answers).not.toHaveBeenCalled();
    });

    it("tells the owner when it could not be scanned for a week", async () => {
        spendTheBudget();
        await upload();
        age(8 * DAY_MS);

        await finishPendingScans();

        expect(pending()).toEqual([]);
        expect(state.scans[0]).toMatchObject({ verdict: "unknown" });
        expect(state.notices).toMatchObject([{ event: "scan.detection" }]);
    });

    it("keeps its place when its storage is away, and lets the others go first", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        const read = vi.spyOn(driver, "readStream").mockRejectedValueOnce(new Error("offline"));

        await finishPendingScans();

        expect(read).toHaveBeenCalled();
        expect(pending()).toHaveLength(1);
        expect(Date.now() - pending()[0]!.updatedAt.getTime()).toBeLessThan(1000);
    });

    it("drops the debt when the submission is gone", async () => {
        spendTheBudget();
        await upload();
        state.submissions.clear();
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(state.scans).toEqual([]);
    });

    it("counts a poll the budget refused as owed, not as a slow analysis", async () => {
        vi.useFakeTimers();
        try {
            answers.mockImplementation(
                async () => new Response(JSON.stringify({ data: { id: "analysis" } }))
            );
            spendTheBudget();
            const verdict = uploadAndScan("key", new Uint8Array([1]), "hash");
            await vi.runAllTimersAsync();
            expect(await verdict).toMatchObject({ kind: "unknown", deferred: true });
        } finally {
            vi.useRealTimers();
        }
    });
});
