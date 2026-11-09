/**
 * Disposable transfers: files handed to somebody by link, or sent to people
 * here, that delete themselves.
 *
 * Modelled on file.io and Firefox Send: a few files, an expiry, a cap on
 * downloads, one link. What is shared is never a Drive item - the bytes sit
 * under Polaris's own folder on the instance's storage, count toward nobody's
 * Drive, and the sweep removes them once the transfer has expired, every file
 * has served its downloads, or the upload was abandoned before it finished.
 *
 * Every limit is enforced here, on each access, because the page that serves a
 * transfer is a page a stranger controls. A download is counted with one
 * conditional update before a byte is sent, so two people racing for the last
 * download of a file cannot both win it.
 */

import { prisma } from "@polaris/db";
import { typeOfFile } from "@/lib/mime";
import { generateToken } from "@polaris/core/tokens";
import { translatorFor } from "@/lib/i18n/translate";
import { sharingBaseUrl } from "@/lib/domain-service";
import { getUserLocale } from "@/lib/i18n/locale-service";
import { mayReceiveFrom } from "@/lib/drive-transfer-service";
import { createNotification } from "@/lib/notification-service";
import {
    driverForTarget,
    LOCAL_TARGET,
    resolveStorageTarget,
    streamFile,
    type UploadTarget
} from "@/lib/storage-target";

/** Which storage new transfers go to. Unset means the instance's own rule: a
 *  NAS when there is one, this server otherwise. */
export const DISPOSABLE_TARGET_KEY = "drive.disposable.target";
/** Under POLARIS_DATA_DIR when the storage is this server. */
const LOCAL_FOLDER = "disposable";
/** Inside whichever storage. */
const ROOT = "polaris/disposable";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** How long a transfer may stand, as offered on the screen. */
export const EXPIRY_CHOICES = {
    "1h": HOUR,
    "1d": DAY,
    "3d": 3 * DAY,
    "7d": 7 * DAY,
    "14d": 14 * DAY
} as const;
export type ExpiryChoice = keyof typeof EXPIRY_CHOICES;
export const DEFAULT_EXPIRY: ExpiryChoice = "1d";

/** Downloads per file. 0 stands for "no cap" in the form; stored as null. */
export const DOWNLOAD_CHOICES = [1, 5, 10, 50, 0] as const;
export const DEFAULT_DOWNLOADS = 1;

/** The most one transfer may hold. A default in code, so an install that never
 *  set anything has a working limit. */
export const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_FILES_PER_TRANSFER = 50;
/** Live transfers one account may have out at once. */
export const MAX_ACTIVE_PER_USER = 25;
/** People one transfer may be sent to. */
export const MAX_RECIPIENTS = 25;
/** How long an upload that was never finished is kept before it is swept. */
export const UNFINISHED_TTL_MS = 12 * HOUR;

/** Said to the person creating or filling a transfer; a catalog key in drive. */
export class TransferRefused extends Error {
    constructor(
        readonly key:
            | "disposable.errors.tooMany"
            | "disposable.errors.notFound"
            | "disposable.errors.tooManyFiles"
            | "disposable.errors.tooLarge"
            | "disposable.errors.finished"
            | "disposable.errors.empty"
    ) {
        super(key);
        this.name = "TransferRefused";
    }
}

export interface TransferFileView {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly downloadsLeft: number | null;
}

export interface TransferView {
    readonly id: string;
    readonly url: string;
    readonly note: string | null;
    readonly expiresAt: string;
    readonly maxDownloads: number | null;
    readonly totalSize: number;
    readonly createdAt: string;
    readonly files: TransferFileView[];
}

/** Why a link holder gets nothing. Deliberately coarse: a stranger learns that
 *  the link is gone, not who made it or when it would have opened. */
export type TransferDenial = "missing" | "expired" | "exhausted";

const fileSelect = {
    id: true,
    name: true,
    size: true,
    contentType: true,
    path: true,
    maxDownloads: true,
    downloadCount: true
} as const;

/** The address a transfer is opened at, on the domain links are shared from. */
export async function transferUrl(token: string): Promise<string> {
    return `${await sharingBaseUrl()}/f/${token}`;
}

function downloadsLeft(file: { maxDownloads: number | null; downloadCount: number }) {
    return file.maxDownloads === null ? null : Math.max(0, file.maxDownloads - file.downloadCount);
}

/** Whether a transfer is spent: every file has served all it may. A transfer
 *  with no files is not spent, it is unfinished. */
export function isExhausted(files: readonly { maxDownloads: number | null; downloadCount: number }[]) {
    return files.length > 0 && files.every((file) => downloadsLeft(file) === 0);
}

/** Start a transfer. Files are added next, then it is finished. */
export async function createTransfer(
    ownerId: string,
    input: { expiry: ExpiryChoice; maxDownloads: number; note?: string | null },
    now: Date = new Date()
): Promise<{ id: string }> {
    const active = await prisma.disposableTransfer.count({
        where: { ownerId, expiresAt: { gt: now } }
    });
    if (active >= MAX_ACTIVE_PER_USER) throw new TransferRefused("disposable.errors.tooMany");
    const target: UploadTarget = await resolveStorageTarget(DISPOSABLE_TARGET_KEY);
    const row = await prisma.disposableTransfer.create({
        data: {
            ownerId,
            token: generateToken(),
            targetId: target.id,
            expiresAt: new Date(now.getTime() + EXPIRY_CHOICES[input.expiry]),
            maxDownloads: input.maxDownloads > 0 ? input.maxDownloads : null,
            note: input.note?.trim() || null
        },
        select: { id: true }
    });
    return row;
}

/** One of the owner's unfinished transfers, or a refusal. */
async function openDraft(ownerId: string, transferId: string) {
    const row = await prisma.disposableTransfer.findFirst({
        where: { id: transferId, ownerId },
        select: {
            id: true,
            targetId: true,
            readyAt: true,
            maxDownloads: true,
            _count: { select: { files: true } }
        }
    });
    if (!row) throw new TransferRefused("disposable.errors.notFound");
    if (row.readyAt) throw new TransferRefused("disposable.errors.finished");
    return row;
}

/**
 * Stream one file into an unfinished transfer.
 *
 * The body arrives already capped by the caller at what is left of the
 * transfer's allowance; the total is then claimed with a conditional update, so
 * two files uploaded side by side cannot both squeeze under the limit.
 */
export async function addFile(input: {
    readonly ownerId: string;
    readonly transferId: string;
    readonly name: string;
    readonly contentType: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly declared?: number;
}): Promise<TransferFileView> {
    const draft = await openDraft(input.ownerId, input.transferId);
    if (draft._count.files >= MAX_FILES_PER_TRANSFER) {
        throw new TransferRefused("disposable.errors.tooManyFiles");
    }
    const folder = `${ROOT}/${draft.id}`;
    const path = `${folder}/${crypto.randomUUID()}`;
    const contentType = typeOfFile(input.contentType, input.name);
    const placed = await streamFile({
        target: { id: draft.targetId, name: draft.targetId, automatic: false },
        localFolder: LOCAL_FOLDER,
        folder,
        path,
        body: input.body,
        mime: contentType,
        declared: input.declared,
        what: "disposable file"
    });
    // The storage may have fallen back elsewhere; the transfer records one
    // place, so a file that did not land there is not kept.
    if (placed.targetId !== draft.targetId) {
        await removeBytes(placed.targetId, [path]);
        throw new TransferRefused("disposable.errors.notFound");
    }
    const claimed = await prisma.disposableTransfer.updateMany({
        where: {
            id: draft.id,
            readyAt: null,
            totalSize: { lte: BigInt(MAX_TRANSFER_BYTES - placed.size) }
        },
        data: { totalSize: { increment: BigInt(placed.size) } }
    });
    if (claimed.count !== 1) {
        await removeBytes(draft.targetId, [path]);
        throw new TransferRefused("disposable.errors.tooLarge");
    }
    const file = await prisma.disposableFile.create({
        data: {
            transferId: draft.id,
            name: readableName(input.name),
            contentType,
            size: BigInt(placed.size),
            path,
            maxDownloads: draft.maxDownloads
        },
        select: fileSelect
    });
    return { id: file.id, name: file.name, size: Number(file.size), downloadsLeft: downloadsLeft(file) };
}

/** What is left of a transfer's allowance, for capping the next upload. */
export async function remainingBytes(ownerId: string, transferId: string): Promise<number> {
    const row = await prisma.disposableTransfer.findFirst({
        where: { id: transferId, ownerId, readyAt: null },
        select: { totalSize: true }
    });
    if (!row) throw new TransferRefused("disposable.errors.notFound");
    return Math.max(0, MAX_TRANSFER_BYTES - Number(row.totalSize));
}

/**
 * Close a transfer to further files and make its link live. People named here
 * are told about it in their own language - only those whose privacy settings
 * accept something from the sender; the rest are returned, not silently lost.
 */
export async function finishTransfer(
    ownerId: string,
    transferId: string,
    recipientIds: readonly string[],
    senderName: string
): Promise<{ url: string; notified: number; refused: number }> {
    const draft = await openDraft(ownerId, transferId);
    if (draft._count.files === 0) throw new TransferRefused("disposable.errors.empty");
    const row = await prisma.disposableTransfer.update({
        where: { id: draft.id },
        data: { readyAt: new Date() },
        select: { token: true, note: true, files: { select: { name: true } } }
    });
    const url = await transferUrl(row.token);
    const wanted = [...new Set(recipientIds)].filter((id) => id !== ownerId).slice(0, MAX_RECIPIENTS);
    const allowed = wanted.length > 0 ? await mayReceiveFrom(ownerId, wanted) : new Set<string>();
    let notified = 0;
    for (const userId of wanted) {
        if (!allowed.has(userId)) continue;
        const t = translatorFor(await getUserLocale(userId), "drive");
        const outcome = await createNotification({
            userId,
            type: "drive.disposable",
            title: t("disposable.notify.title", { name: senderName }),
            body:
                row.note ??
                t("disposable.notify.body", {
                    count: row.files.length,
                    first: row.files[0]?.name ?? ""
                }),
            href: `/f/${row.token}`,
            level: "info"
        });
        if (outcome !== "failed") notified += 1;
    }
    return { url, notified, refused: wanted.length - notified };
}

/** The owner's live transfers, newest first. */
export async function listTransfers(ownerId: string, now: Date = new Date()): Promise<TransferView[]> {
    const rows = await prisma.disposableTransfer.findMany({
        where: { ownerId, readyAt: { not: null }, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
        take: MAX_ACTIVE_PER_USER,
        select: {
            id: true,
            token: true,
            note: true,
            expiresAt: true,
            maxDownloads: true,
            totalSize: true,
            createdAt: true,
            files: { select: fileSelect, orderBy: { createdAt: "asc" } }
        }
    });
    const base = await sharingBaseUrl();
    return rows
        .filter((row) => !isExhausted(row.files))
        .map((row) => ({
            id: row.id,
            url: `${base}/f/${row.token}`,
            note: row.note,
            expiresAt: row.expiresAt.toISOString(),
            maxDownloads: row.maxDownloads,
            totalSize: Number(row.totalSize),
            createdAt: row.createdAt.toISOString(),
            files: row.files.map((file) => ({
                id: file.id,
                name: file.name,
                size: Number(file.size),
                downloadsLeft: downloadsLeft(file)
            }))
        }));
}

/** Take a transfer back: the rows and the bytes go now, not at the next sweep.
 *  Someone else's id, or one already gone, is a quiet no-op. */
export async function revokeTransfer(ownerId: string, transferId: string): Promise<boolean> {
    const row = await prisma.disposableTransfer.findFirst({
        where: { id: transferId, ownerId },
        select: { id: true, targetId: true, files: { select: { path: true } } }
    });
    if (!row) return false;
    await prisma.disposableTransfer.deleteMany({ where: { id: row.id } });
    await removeBytes(row.targetId, row.files.map((file) => file.path), `${ROOT}/${row.id}`);
    return true;
}

/** What a link holder may see: the files still downloadable, or why not. */
export async function openTransfer(
    token: string,
    now: Date = new Date()
): Promise<
    | { ok: true; id: string; note: string | null; expiresAt: Date; files: TransferFileView[] }
    | { ok: false; reason: TransferDenial }
> {
    if (!token || token.length > 128) return { ok: false, reason: "missing" };
    const row = await prisma.disposableTransfer.findUnique({
        where: { token },
        select: {
            id: true,
            note: true,
            readyAt: true,
            expiresAt: true,
            files: { select: fileSelect, orderBy: { createdAt: "asc" } }
        }
    });
    if (!row || !row.readyAt) return { ok: false, reason: "missing" };
    if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
    if (isExhausted(row.files)) return { ok: false, reason: "exhausted" };
    return {
        ok: true,
        id: row.id,
        note: row.note,
        expiresAt: row.expiresAt,
        files: row.files
            .filter((file) => downloadsLeft(file) !== 0)
            .map((file) => ({
                id: file.id,
                name: file.name,
                size: Number(file.size),
                downloadsLeft: downloadsLeft(file)
            }))
    };
}

/**
 * Spend one download of one file and say where its bytes are. The count is
 * taken by a single conditional update before anything is streamed, so the cap
 * holds however many requests arrive at once.
 */
export async function claimDownload(
    token: string,
    fileId: string,
    now: Date = new Date()
): Promise<
    | {
          ok: true;
          file: { name: string; size: number; contentType: string; path: string; targetId: string };
      }
    | { ok: false; reason: TransferDenial }
> {
    const opened = await openTransfer(token, now);
    if (!opened.ok) return opened;
    const file = await prisma.disposableFile.findFirst({
        where: { id: fileId, transferId: opened.id },
        select: { ...fileSelect, transfer: { select: { targetId: true } } }
    });
    if (!file) return { ok: false, reason: "missing" };
    const spent = await prisma.disposableFile.updateMany({
        where: {
            id: file.id,
            transfer: { expiresAt: { gt: now } },
            OR: [
                { maxDownloads: null },
                { maxDownloads: { gt: prisma.disposableFile.fields.downloadCount } }
            ]
        },
        data: { downloadCount: { increment: 1 } }
    });
    if (spent.count !== 1) return { ok: false, reason: "exhausted" };
    return {
        ok: true,
        file: {
            name: file.name,
            size: Number(file.size),
            contentType: file.contentType,
            path: file.path,
            targetId: file.transfer.targetId
        }
    };
}

/** A storage driver for reading one transfer's bytes. */
export function openTransferStorage(targetId: string) {
    return driverForTarget(targetId, LOCAL_FOLDER);
}

/**
 * Delete everything that has ended: expired, spent, or never finished. Rows go
 * first, so a link stops working even when the storage is not answering; the
 * bytes follow best effort and an unreachable storage is simply tried again by
 * nobody - the folder is Polaris's own and holds nothing a row still names.
 */
export async function sweepDisposableTransfers(
    now: Date = new Date()
): Promise<{ swept: number }> {
    const ended = await prisma.disposableTransfer.findMany({
        where: {
            OR: [
                { expiresAt: { lte: now } },
                { readyAt: null, createdAt: { lt: new Date(now.getTime() - UNFINISHED_TTL_MS) } },
                { readyAt: { not: null }, maxDownloads: { not: null } }
            ]
        },
        take: 500,
        select: {
            id: true,
            targetId: true,
            expiresAt: true,
            readyAt: true,
            createdAt: true,
            files: { select: { path: true, maxDownloads: true, downloadCount: true } }
        }
    });
    const due = ended.filter(
        (row) =>
            row.expiresAt.getTime() <= now.getTime() ||
            (row.readyAt === null && row.createdAt.getTime() < now.getTime() - UNFINISHED_TTL_MS) ||
            (row.readyAt !== null && isExhausted(row.files))
    );
    if (due.length === 0) return { swept: 0 };
    await prisma.disposableTransfer.deleteMany({ where: { id: { in: due.map((row) => row.id) } } });
    for (const row of due) {
        await removeBytes(row.targetId, row.files.map((file) => file.path), `${ROOT}/${row.id}`);
    }
    return { swept: due.length };
}

/** Best effort: the rows are already gone, and an unreachable storage is not a
 *  reason to keep a link alive. */
async function removeBytes(targetId: string, paths: readonly string[], folder?: string) {
    const driver = await driverForTarget(targetId || LOCAL_TARGET, LOCAL_FOLDER).catch(() => null);
    if (!driver) return;
    try {
        for (const path of paths) await driver.delete(path).catch(() => undefined);
        if (folder) await driver.delete(folder, { recursive: true }).catch(() => undefined);
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

/** A name as it is shown and served back: no path, no control characters,
 *  bounded. Never used to build a storage path. */
export function readableName(name: string): string {
    const last = name.split(/[\\/]/).pop() ?? "";
    const clean = last.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255);
    return clean || "file";
}
