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
    path?: string | null;
    detail?: string | null;
    createdAt: Date;
    updatedAt: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const state = vi.hoisted(() => ({
    scans: [] as Row[],
    submissions: new Map<string, { status: string; storedPath?: string }>(),
    deleted: [] as string[],
    moved: [] as [string, string][],
    notices: [] as { event: string }[],
    notify: null as (() => Promise<void>) | null,
    onDetection: "block",
    size: 5
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
                          storedPath:
                              state.submissions.get(where.id)?.storedPath ?? "drop/report.pdf",
                          size: BigInt(state.size),
                          status: state.submissions.get(where.id)?.status,
                          submittedByUserId: null,
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
    stat: async () => ({}),
    readStream: async () => file(),
    delete: async (path: string) => void state.deleted.push(path),
    mkdir: async () => undefined,
    move: async (from: string, to: string) => void state.moved.push([from, to]),
    dispose: async () => undefined
};

vi.mock("@/lib/storage-service", () => ({ getDriverForConnection: async () => driver }));
vi.mock("@/lib/drive-meta-service", () => ({ recordItemCreator: async () => undefined }));
vi.mock("@/lib/drive-folder-size", () => ({ invalidateFolderSizes: async () => undefined }));
vi.mock("@/lib/file-request-service", () => ({
    setSubmissionPath: async (id: string, storedPath: string) => {
        Object.assign(state.submissions.get(id) ?? {}, { storedPath });
    }
}));
vi.mock("@/lib/integration-service", () => ({
    getIntegrationState: async () => ({ enabled: true, config: {} }),
    getIntegrationSecret: async () => "key"
}));
vi.mock("@/lib/integrations/registry", () => ({
    readVirusTotalConfig: () => ({ scanDropPoints: true, onDetection: state.onDetection })
}));
vi.mock("@/lib/notifications/dispatch", () => ({
    notify: async (notice: { event: string }) => {
        await state.notify?.();
        state.notices.push(notice);
    }
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
const { clearProviderPause } = await import("@/lib/integrations/provider-pause");

const upload = (destination?: string) =>
    scanDropPointUpload({
        driver: driver as never,
        connectionId: "connection",
        storedPath: "drop/.staged",
        destination,
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

const clean = new Response(
    JSON.stringify({ data: { attributes: { last_analysis_stats: { harmless: 9 } } } })
);
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
        state.moved = [];
        state.notices = [];
        state.notify = null;
        state.onDetection = "block";
        state.size = 5;
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
        expect(state.scans[0]).toMatchObject({
            verdict: "unknown",
            detail: "scan.waitedTooLong"
        });
        expect(state.notices).toMatchObject([{ event: "scan.detection" }]);
    });

    it("keeps its place when its storage is away, and lets the others go first", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        const stat = vi.spyOn(driver, "stat").mockRejectedValueOnce(new Error("offline"));

        await finishPendingScans();

        expect(stat).toHaveBeenCalled();
        expect(answers).not.toHaveBeenCalled();
        expect(pending()).toHaveLength(1);
        expect(Date.now() - pending()[0]!.updatedAt.getTime()).toBeLessThan(1000);
    });

    it.each([429, 500, 503])("stays owed when VirusTotal answers %i", async (status) => {
        answers.mockImplementation(async () => new Response("{}", { status }));

        await upload();

        expect(pending()).toHaveLength(1);
        expect(state.notices).toEqual([]);
        await clearProviderPause("virustotal");
    });

    it("stays owed when a retry fails, and is finished by the next one", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        answers.mockImplementationOnce(async () => new Response("{}", { status: 503 }));

        await finishPendingScans();

        expect(pending()).toHaveLength(1);
        await clearProviderPause("virustotal");
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(state.submissions.get("submission")?.status).toBe("blocked");
        expect(pending()).toEqual([]);
    });

    it("takes a refusal of the file itself as the answer", async () => {
        answers.mockImplementation(async () => new Response("{}", { status: 422 }));

        expect(await upload()).toMatchObject({ verdict: "error" });

        expect(pending()).toEqual([]);
    });

    it("stays owed if acting on the verdict fails", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        state.notify = async () => {
            throw new Error("down");
        };

        await finishPendingScans();

        expect(state.submissions.get("submission")?.status).toBe("blocked");
        expect(pending()).toHaveLength(1);
    });

    it("does not act twice on a file an earlier pass already blocked", async () => {
        spendTheBudget();
        await upload();
        state.submissions.set("submission", { status: "blocked" });
        resetLookupBudget();
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(answers).not.toHaveBeenCalled();
        expect(state.deleted).toEqual([]);
        expect(pending()).toEqual([]);
    });

    it("does not read the file while there is nothing to ask with", async () => {
        spendTheBudget();
        await upload();
        age(2 * 60 * 1000);
        const read = vi.spyOn(driver, "readStream");
        read.mockClear();

        await finishPendingScans();

        expect(read).not.toHaveBeenCalled();
    });

    it("does not read the file when VirusTotal knows its hash", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        const read = vi.spyOn(driver, "readStream");
        read.mockClear();

        await finishPendingScans();

        expect(read).not.toHaveBeenCalled();
        expect(state.submissions.get("submission")?.status).toBe("blocked");
    });

    it("uploads a file VirusTotal has not seen, reading it only then", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        age(2 * 60 * 1000);
        const read = vi.spyOn(driver, "readStream");
        read.mockClear();
        answers.mockImplementation(async (url) =>
            url.endsWith("/files")
                ? new Response(JSON.stringify({ data: { id: "analysis" } }))
                : url.includes("/analyses/")
                  ? new Response(
                        JSON.stringify({
                            data: { attributes: { status: "completed", stats: { malicious: 2 } } }
                        })
                    )
                  : new Response("{}", { status: 404 })
        );
        vi.useFakeTimers();
        try {
            const sweep = finishPendingScans();
            await vi.runAllTimersAsync();
            await sweep;
        } finally {
            vi.useRealTimers();
        }

        expect(read).toHaveBeenCalledTimes(1);
        expect(state.submissions.get("submission")?.status).toBe("blocked");
    });

    it("says a file too large to upload could not be scanned, unread", async () => {
        spendTheBudget();
        await upload();
        resetLookupBudget();
        state.size = 33 * 1024 * 1024;
        age(2 * 60 * 1000);
        answers.mockImplementation(async () => new Response("{}", { status: 404 }));
        const read = vi.spyOn(driver, "readStream");
        read.mockClear();

        await finishPendingScans();

        expect(read).not.toHaveBeenCalled();
        expect(pending()).toEqual([]);
    });

    it("holds an overwrite back until it is cleared, then puts it in place", async () => {
        spendTheBudget();
        expect(await upload("drop/report.pdf")).toMatchObject({ deferred: true });
        state.submissions.set("submission", { status: "stored", storedPath: "drop/.staged" });
        resetLookupBudget();
        age(2 * 60 * 1000);
        answers.mockImplementation(async () => clean.clone());

        await finishPendingScans();

        expect(
            state.moved.some(([from, to]) => from === "drop/.staged" && to === "drop/report.pdf")
        ).toBe(true);
        expect(state.submissions.get("submission")?.storedPath).toBe("drop/report.pdf");
        expect(pending()).toEqual([]);
    });

    it("never touches the replaced file when a held overwrite is malicious", async () => {
        spendTheBudget();
        await upload("drop/report.pdf");
        state.submissions.set("submission", { status: "stored", storedPath: "drop/.staged" });
        resetLookupBudget();
        age(2 * 60 * 1000);

        await finishPendingScans();

        expect(state.deleted).toEqual(["drop/.staged"]);
        expect(state.moved).toEqual([]);
    });

    it("keeps a held overwrite under its own name if it was never scanned", async () => {
        spendTheBudget();
        await upload("drop/report.pdf");
        state.submissions.set("submission", { status: "stored", storedPath: "drop/.staged" });
        age(8 * DAY_MS);

        await finishPendingScans();

        expect(state.moved).toEqual([]);
        expect(state.submissions.get("submission")?.storedPath).toBe("drop/.staged");
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
