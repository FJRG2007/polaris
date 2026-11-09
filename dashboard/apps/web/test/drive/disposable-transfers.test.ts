/**
 * Quick send's server rules: a link opens only once finished and before it
 * expires, a capped file serves exactly its downloads however many requests race
 * for the last one, the sweep removes what has ended and nothing else, and only
 * the owner can take a transfer back.
 *
 * The database is a small in-memory stand-in that evaluates the same conditional
 * updates the service sends, so a cap enforced only in application code - read,
 * then write - would let concurrent claims through here as it would in Postgres.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface TransferRow {
    id: string;
    ownerId: string;
    token: string;
    targetId: string;
    expiresAt: Date;
    maxDownloads: number | null;
    totalSize: bigint;
    readyAt: Date | null;
    note: string | null;
    createdAt: Date;
}
interface FileRow {
    id: string;
    transferId: string;
    name: string;
    contentType: string;
    size: bigint;
    path: string;
    maxDownloads: number | null;
    downloadCount: number;
    createdAt: Date;
}

const transfers: TransferRow[] = [];
const files: FileRow[] = [];
const deleted: string[] = [];
const FIELD = Symbol("downloadCount");
let sequence = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`;

const withFiles = (row: TransferRow) => ({
    ...row,
    files: files.filter((file) => file.transferId === row.id),
    _count: { files: files.filter((file) => file.transferId === row.id).length }
});

/** Just the where shapes the service sends. */
function transferMatches(row: TransferRow, where: Record<string, any>): boolean {
    if (where.id !== undefined && (typeof where.id === "string" ? row.id !== where.id : !where.id.in.includes(row.id))) return false;
    if (where.ownerId !== undefined && row.ownerId !== where.ownerId) return false;
    if (where.token !== undefined && row.token !== where.token) return false;
    if (where.readyAt === null && row.readyAt !== null) return false;
    if (where.readyAt?.not === null && row.readyAt === null) return false;
    if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return false;
    if (where.expiresAt?.lte && !(row.expiresAt <= where.expiresAt.lte)) return false;
    if (where.createdAt?.lt && !(row.createdAt < where.createdAt.lt)) return false;
    if (where.maxDownloads?.not === null && row.maxDownloads === null) return false;
    if (where.totalSize?.lte !== undefined && !(row.totalSize <= where.totalSize.lte)) return false;
    if (where.OR && !where.OR.some((branch: Record<string, any>) => transferMatches(row, branch))) return false;
    return true;
}

const prisma = {
    disposableTransfer: {
        count: async ({ where }: any) => transfers.filter((row) => transferMatches(row, where)).length,
        create: async ({ data }: any) => {
            const row: TransferRow = {
                id: uuid(),
                totalSize: 0n,
                readyAt: null,
                note: null,
                createdAt: new Date(),
                maxDownloads: null,
                ...data
            };
            transfers.push(row);
            return row;
        },
        findFirst: async ({ where }: any) => {
            const row = transfers.find((one) => transferMatches(one, where));
            return row ? withFiles(row) : null;
        },
        findUnique: async ({ where }: any) => {
            const row = transfers.find((one) => one.token === where.token);
            return row ? withFiles(row) : null;
        },
        findMany: async ({ where }: any) => transfers.filter((row) => transferMatches(row, where)).map(withFiles),
        update: async ({ where, data }: any) => {
            const row = transfers.find((one) => one.id === where.id)!;
            Object.assign(row, data);
            return withFiles(row);
        },
        updateMany: async ({ where, data }: any) => {
            const hit = transfers.filter((row) => transferMatches(row, where));
            for (const row of hit) row.totalSize += data.totalSize.increment;
            return { count: hit.length };
        },
        deleteMany: async ({ where }: any) => {
            const gone = transfers.filter((row) => transferMatches(row, where));
            for (const row of gone) {
                transfers.splice(transfers.indexOf(row), 1);
                for (const file of files.filter((one) => one.transferId === row.id)) {
                    files.splice(files.indexOf(file), 1);
                }
            }
            return { count: gone.length };
        }
    },
    disposableFile: {
        fields: { downloadCount: FIELD },
        create: async ({ data }: any) => {
            const row: FileRow = { id: uuid(), downloadCount: 0, createdAt: new Date(), ...data };
            files.push(row);
            return row;
        },
        findFirst: async ({ where }: any) => {
            const row = files.find((one) => one.id === where.id && one.transferId === where.transferId);
            if (!row) return null;
            return { ...row, transfer: { targetId: transfers.find((one) => one.id === row.transferId)!.targetId } };
        },
        // One synchronous step, as a single UPDATE ... WHERE is in Postgres.
        updateMany: async ({ where, data }: any) => {
            const row = files.find((one) => one.id === where.id);
            if (!row) return { count: 0 };
            const parent = transfers.find((one) => one.id === row.transferId);
            if (!parent || !(parent.expiresAt > where.transfer.expiresAt.gt)) return { count: 0 };
            const open = where.OR.some((branch: any) =>
                branch.maxDownloads === null
                    ? row.maxDownloads === null
                    : branch.maxDownloads.gt === FIELD && row.maxDownloads !== null && row.maxDownloads > row.downloadCount
            );
            if (!open) return { count: 0 };
            row.downloadCount += data.downloadCount.increment;
            return { count: 1 };
        }
    }
};

vi.mock("@polaris/db", () => ({ prisma }));
vi.mock("@/lib/domain-service", () => ({ sharingBaseUrl: async () => "https://share.example.test" }));
const notifications: { userId: string; href: string }[] = [];
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string; href: string }) => {
        notifications.push(input);
        return "created";
    }
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/i18n/translate", () => ({ translatorFor: () => (key: string) => key }));
const receivers = new Set<string>();
vi.mock("@/lib/drive-transfer-service", () => ({
    mayReceiveFrom: async (_sender: string, ids: readonly string[]) => new Set(ids.filter((id) => receivers.has(id)))
}));
vi.mock("@/lib/storage-target", () => ({
    LOCAL_TARGET: "local",
    resolveStorageTarget: async () => ({ id: "local", name: "This server", automatic: true }),
    streamFile: async (input: { body: ReadableStream<Uint8Array> }) => {
        let size = 0;
        const reader = input.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
        }
        return { targetId: "local", size, fellBackFrom: null };
    },
    driverForTarget: async () => ({
        delete: async (path: string) => void deleted.push(path),
        dispose: async () => undefined
    })
}));

const service = await import("@/lib/disposable-transfer-service");

const OWNER = "11111111-1111-4111-8111-111111111111";
const STRANGER = "22222222-2222-4222-8222-222222222222";

function body(bytes: number): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
        }
    });
}

async function ready(options: { maxDownloads?: number; expiry?: service.ExpiryChoice; fileCount?: number } = {}) {
    const { id } = await service.createTransfer(OWNER, {
        expiry: options.expiry ?? "1d",
        maxDownloads: options.maxDownloads ?? 1
    });
    for (let index = 0; index < (options.fileCount ?? 1); index += 1) {
        await service.addFile({ ownerId: OWNER, transferId: id, name: `report ${index}.pdf`, contentType: "application/pdf", body: body(10) });
    }
    const done = await service.finishTransfer(OWNER, id, [], "Owner");
    const token = done.url.split("/f/")[1]!;
    return { id, token, url: done.url };
}

beforeEach(() => {
    transfers.length = 0;
    files.length = 0;
    deleted.length = 0;
    notifications.length = 0;
    receivers.clear();
});

describe("opening a transfer", () => {
    it("serves nothing until it is finished, and builds the link on the sharing domain", async () => {
        const { id } = await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });
        const token = transfers.find((row) => row.id === id)!.token;
        expect(await service.openTransfer(token)).toEqual({ ok: false, reason: "missing" });
        await expect(service.finishTransfer(OWNER, id, [], "Owner")).rejects.toThrow("disposable.errors.empty");

        const live = await ready();
        expect(live.url.startsWith("https://share.example.test/f/")).toBe(true);
        const opened = await service.openTransfer(live.token);
        expect(opened.ok && opened.files.map((file) => file.name)).toEqual(["report 0.pdf"]);
    });

    it("refuses once the expiry has passed", async () => {
        const { token } = await ready({ expiry: "1h" });
        const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
        expect(await service.openTransfer(token, later)).toEqual({ ok: false, reason: "expired" });
        const file = files[0]!;
        expect(await service.claimDownload(token, file.id, later)).toEqual({ ok: false, reason: "expired" });
    });

    it("does not let a file of one transfer be fetched through another's token", async () => {
        const first = await ready();
        const second = await ready();
        const foreign = files.find((file) => file.transferId === second.id)!;
        expect(await service.claimDownload(first.token, foreign.id)).toEqual({ ok: false, reason: "missing" });
    });
});

describe("counting downloads", () => {
    it("serves a one-time file exactly once when many requests race for it", async () => {
        const { token } = await ready({ maxDownloads: 1 });
        const file = files[0]!;
        const answers = await Promise.all(Array.from({ length: 20 }, () => service.claimDownload(token, file.id)));
        expect(answers.filter((answer) => answer.ok)).toHaveLength(1);
        expect(file.downloadCount).toBe(1);
        expect(await service.openTransfer(token)).toEqual({ ok: false, reason: "exhausted" });
    });

    it("caps each file on its own, so one spent file leaves the others downloadable", async () => {
        const { token } = await ready({ maxDownloads: 2, fileCount: 2 });
        const [first, second] = files;
        await service.claimDownload(token, first!.id);
        await service.claimDownload(token, first!.id);
        expect((await service.claimDownload(token, first!.id)).ok).toBe(false);
        const opened = await service.openTransfer(token);
        expect(opened.ok && opened.files.map((file) => file.id)).toEqual([second!.id]);
    });

    it("never runs out when there is no cap", async () => {
        const { token } = await ready({ maxDownloads: 0 });
        for (let index = 0; index < 30; index += 1) {
            expect((await service.claimDownload(token, files[0]!.id)).ok).toBe(true);
        }
    });
});

describe("bounds", () => {
    it("refuses a file that would take the transfer over its size limit", async () => {
        const { id } = await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });
        transfers[0]!.totalSize = BigInt(service.MAX_TRANSFER_BYTES - 5);
        await expect(
            service.addFile({ ownerId: OWNER, transferId: id, name: "big.bin", contentType: "", body: body(10) })
        ).rejects.toThrow("disposable.errors.tooLarge");
        expect(files).toHaveLength(0);
        expect(deleted).toHaveLength(1);
    });

    it("refuses another transfer past the per-account limit", async () => {
        for (let index = 0; index < service.MAX_ACTIVE_PER_USER; index += 1) {
            await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });
        }
        await expect(service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 })).rejects.toThrow(
            "disposable.errors.tooMany"
        );
    });

    it("keeps a name to its last segment, without control characters", () => {
        expect(service.readableName("../../etc/pa\u0000sswd")).toBe("passwd");
        expect(service.readableName("C:\\Users\\me\\<script>.html")).toBe("<script>.html");
        expect(service.readableName("   ")).toBe("file");
    });
});

describe("who may act", () => {
    it("lets only the owner take a transfer back, and deletes its bytes", async () => {
        const { id, token } = await ready();
        expect(await service.revokeTransfer(STRANGER, id)).toBe(false);
        expect((await service.openTransfer(token)).ok).toBe(true);
        expect(await service.revokeTransfer(OWNER, id)).toBe(true);
        expect(await service.openTransfer(token)).toEqual({ ok: false, reason: "missing" });
        expect(deleted.some((path) => path.includes(id))).toBe(true);
    });

    it("refuses a stranger adding files to somebody's transfer", async () => {
        const { id } = await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });
        await expect(
            service.addFile({ ownerId: STRANGER, transferId: id, name: "x", contentType: "", body: body(1) })
        ).rejects.toThrow("disposable.errors.notFound");
    });

    it("notifies only the people who accept files from the sender", async () => {
        const { id } = await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });
        await service.addFile({ ownerId: OWNER, transferId: id, name: "a.txt", contentType: "", body: body(1) });
        receivers.add(STRANGER);
        const other = "33333333-3333-4333-8333-333333333333";
        const done = await service.finishTransfer(OWNER, id, [STRANGER, other, OWNER], "Owner");
        expect(done).toMatchObject({ notified: 1, refused: 1 });
        expect(notifications.map((one) => one.userId)).toEqual([STRANGER]);
        expect(notifications[0]!.href.startsWith("/f/")).toBe(true);
    });
});

describe("the sweep", () => {
    it("removes expired, spent and abandoned transfers and keeps the live ones", async () => {
        const live = await ready({ maxDownloads: 5 });
        const expired = await ready({ expiry: "1h" });
        const spent = await ready({ maxDownloads: 1 });
        await service.claimDownload(spent.token, files.find((file) => file.transferId === spent.id)!.id);
        const abandoned = await service.createTransfer(OWNER, { expiry: "14d", maxDownloads: 1 });
        transfers.find((row) => row.id === abandoned.id)!.createdAt = new Date(Date.now() - service.UNFINISHED_TTL_MS - 1000);
        const fresh = await service.createTransfer(OWNER, { expiry: "1d", maxDownloads: 1 });

        const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
        expect(await service.sweepDisposableTransfers(now)).toEqual({ swept: 3 });
        expect(transfers.map((row) => row.id).sort()).toEqual([live.id, fresh.id].sort());
        expect(deleted.some((path) => path.includes(expired.id))).toBe(true);
        expect(await service.sweepDisposableTransfers(now)).toEqual({ swept: 0 });
    });
});
