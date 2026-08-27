/**
 * Which storage a kind of upload is written to.
 *
 * Polaris already knows how to reach a NAS over SMB, an NFS export or an SFTP
 * host, so nothing that accepts a file needs a second way of writing bytes. It
 * needs a decision: which of those, or the disk Polaris itself runs on. That
 * decision is one setting per kind of upload - files attached to work, profile
 * photos - and until an administrator makes it the answer is the obvious one: a
 * NAS if this instance has one, because that is the disk with the room and the
 * backups, otherwise the disk next to Polaris's own data.
 *
 * The choice is re-read on every write rather than frozen, so connecting a NAS
 * later moves new files onto it without a migration. What is already stored
 * records the connection it was written to and stays readable where it is.
 */

import { prisma } from "@polaris/db";
import { mkdir } from "node:fs/promises";
import { loadEnv } from "@polaris/config";
import { isPersonalKind, LOCAL_TARGET, PERSONAL_KIND, withTimeout } from "@polaris/core";
import { LocalDriver } from "@polaris/storage";
import { getSetting } from "@/lib/setting-store";
import type { StorageDriver } from "@polaris/storage";
import { getDriverForConnection } from "@/lib/storage-service";

/** Chosen by nobody, so chosen by the rule below. */
export const AUTOMATIC_TARGET = "auto";
/** The disk Polaris runs on. Its name is shared vocabulary, so it is defined
 *  once in @polaris/core and re-exported here for everything that already
 *  reaches for it through this module. */
export { LOCAL_TARGET };

/** The kinds that mean "a box built to hold files", in the order they are
 *  preferred when nobody has chosen. */
const NAS_KINDS = ["unifi-unas", "smb", "nfs"] as const;

export interface UploadTarget {
    /** A storage connection id, or `local`. */
    readonly id: string;
    readonly name: string;
    /** True when this was worked out rather than chosen. */
    readonly automatic: boolean;
}

/** A connection an administrator can point uploads at. */
export interface TargetOption {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
}

/**
 * Where a given kind of upload should go right now.
 *
 * A connection somebody deleted must not stop uploads: rather than failing every
 * write from then on, the setting falls through to the automatic rule.
 */
export async function resolveStorageTarget(settingKey: string): Promise<UploadTarget> {
    return resolveTargetChoice(await getSetting(settingKey));
}

/**
 * The same, for a choice that is stored somewhere other than a setting.
 *
 * A camera carries its own, so its footage can go on the disk that suits it -
 * a doorbell on the NAS, the garage on whatever is nearest - and null means "the
 * one this instance is set to", which is what nearly every camera keeps.
 */
export async function resolveTargetChoice(value: string | null): Promise<UploadTarget> {
    const choice = value ?? AUTOMATIC_TARGET;
    if (choice === LOCAL_TARGET) return { id: LOCAL_TARGET, name: "This server", automatic: false };
    if (choice !== AUTOMATIC_TARGET) {
        const chosen = await prisma.storageConnection.findUnique({
            where: { id: choice },
            select: { id: true, name: true, kind: true }
        });
        // Somebody's own drive is never a destination for what the instance
        // writes: it is one person's room, and the files Polaris puts away here
        // belong to everybody. It is kept out of the picker, so a choice that
        // names one is a stale or hand-set value and falls through to the rule.
        if (chosen && !isPersonalKind(chosen.kind)) {
            return { id: chosen.id, name: chosen.name, automatic: false };
        }
    }

    const connections = await prisma.storageConnection.findMany({
        where: { kind: { in: [...NAS_KINDS] } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true }
    });
    for (const kind of NAS_KINDS) {
        const match = connections.find((connection) => connection.kind === kind);
        if (match) return { id: match.id, name: match.name, automatic: true };
    }
    return { id: LOCAL_TARGET, name: "This server", automatic: true };
}

/** Everything an administrator may point uploads at, for the settings screen. */
export function storageTargetOptions(): Promise<TargetOption[]> {
    return prisma.storageConnection.findMany({
        where: { kind: { not: PERSONAL_KIND } },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, kind: true }
    });
}

/**
 * A driver onto whichever storage a target names.
 *
 * `localFolder` is the folder under POLARIS_DATA_DIR used when the target is
 * this server. The local driver refuses a root that is not there, and on a fresh
 * install it is not there until the first file arrives - so the folder is made
 * here rather than left to whoever installs Polaris.
 */
export async function driverForTarget(
    targetId: string,
    localFolder: string
): Promise<StorageDriver> {
    if (targetId === LOCAL_TARGET) {
        const root = `${loadEnv().POLARIS_DATA_DIR}/${localFolder}`;
        await mkdir(root, { recursive: true });
        const driver = new LocalDriver({ id: LOCAL_TARGET, root });
        await driver.connect();
        return driver;
    }
    return getDriverForConnection(targetId);
}

/** A storage that is open and ready to be written to, and where that turned out
 *  to be. */
export interface WritableTarget {
    readonly driver: StorageDriver;
    /** Where the bytes will actually land: a connection id, or `local`. Record
     *  THIS on the row, never the target that was asked for. */
    readonly targetId: string;
    /** What to call it. */
    readonly name: string;
    /** The storage that was chosen, when it is not the one that opened. */
    readonly fellBackFrom: string | null;
}

/**
 * Open the storage an upload should go to, or the next best thing.
 *
 * Reaching a storage connection is a TCP connect, a login and a tree connect
 * against a box somebody may have unplugged, and it throws when that box is not
 * there. Every upload in Polaris used to let that throw escape, which is how an
 * unplugged NAS became "that could not be sent" on a voice message, a profile
 * photo that would not save and a task attachment that failed to upload - three
 * screens, three bug reports, one unplugged NAS.
 *
 * None of those is worth losing what somebody just made. The disk Polaris runs
 * on is always reachable, because Polaris is running, so that is where the bytes
 * go instead - loudly, because an operator has a share to go and fix, and
 * recorded, because what is read back later must follow where the file went
 * rather than where the setting points by then.
 *
 * The caller therefore has to store `targetId`. A caller that cannot - one whose
 * rows do not record a storage - must not use this, because for it a fallback
 * would write the file somewhere it will later look for it in vain.
 */
export async function openForWriting(
    target: UploadTarget,
    localFolder: string
): Promise<WritableTarget> {
    if (target.id !== LOCAL_TARGET && failedRecently(target.id)) {
        return { ...(await here(localFolder)), fellBackFrom: target.name };
    }

    try {
        const opened = {
            driver: await driverForTarget(target.id, localFolder),
            targetId: target.id,
            name: target.name,
            fellBackFrom: null
        };
        FAILED.delete(target.id);
        return opened;
    } catch (error) {
        if (target.id === LOCAL_TARGET) throw error;
        FAILED.set(target.id, Date.now());
        console.error(`storage: ${target.name} could not be opened for writing:`, error);
        return { ...(await here(localFolder)), fellBackFrom: target.name };
    }
}

/**
 * A file that no storage would keep.
 *
 * Its own error because a caller has to say something different about it: not
 * "that could not be saved", which reads as a bug in Polaris, but which storage
 * refused the bytes and what it said.
 */
export class StorageRefused extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StorageRefused";
    }
}

/** How long one file may take to be written and read back before the storage is
 *  treated as gone. Generous by an order of magnitude for anything Polaris puts
 *  through here over a local network, and short enough that a share which has
 *  stopped answering falls through while somebody is still on the screen. */
const PLACE_TIMEOUT_MS = 60_000;

/**
 * Put bytes somewhere that will give them back, and say where that was.
 *
 * The whole of what an upload has to get right, in one place, because it was in
 * two and only one of them was right: a voice message survived an unplugged NAS
 * and a profile photo did not, which is one bug wearing two faces.
 *
 * Four things have to hold, and only the first is what "the write succeeded"
 * usually means:
 *
 * - the storage answers at all. `openForWriting` handles that one, and falls
 *   through to this server when it does not.
 * - it does not hang. A storage that refuses is answered in a moment; one that
 *   goes quiet would hold the request until the platform gave up on it.
 * - it kept every byte. Drivers end a write by stat'ing what they wrote, so the
 *   size is free to check.
 * - it gives them back. A share that has gone away, a mount that accepts writes
 *   into nothing and a handle still held open all stat perfectly and refuse the
 *   read - so the file is opened once, now, while there is still another
 *   storage to try.
 *
 * The caller records `targetId`. A caller whose rows cannot record where a file
 * went must not use this: for it a fallback writes the file somewhere it will
 * later look for in vain.
 */
export async function placeFile(input: {
    readonly target: UploadTarget;
    readonly localFolder: string;
    /** Made if it is not there. */
    readonly folder: string;
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mime: string;
    /** What to call this kind of file in a log line. */
    readonly what: string;
}): Promise<{ targetId: string; fellBackFrom: string | null }> {
    const chosen = await openForWriting(input.target, input.localFolder);
    const attempt = await writeThrough(chosen.driver, input);
    if (attempt.ok) return { targetId: chosen.targetId, fellBackFrom: chosen.fellBackFrom };

    // It answered and still would not keep the file. Worth knowing, worth
    // fixing, and not worth losing what somebody just made: the disk Polaris
    // runs on is always reachable, because Polaris is running.
    if (chosen.targetId === LOCAL_TARGET) {
        throw new StorageRefused(
            `${chosen.name} could not take the ${input.what}: ${attempt.detail}`
        );
    }
    console.warn(
        `storage: ${chosen.name} could not take a ${input.what} (${attempt.detail}); writing it to this server instead.`
    );

    // Opening this server can fail too - a data directory that is not writable -
    // and that throw has to arrive as the same sentence as any other refusal.
    // Raw, it reads as a bug in Polaris rather than as two disks saying no.
    const here = await openForWriting(
        { id: LOCAL_TARGET, name: "this server", automatic: true },
        input.localFolder
    )
        .then((local) => writeThrough(local.driver, input))
        .catch((error: unknown) => ({ ok: false, detail: message(error) }));
    if (here.ok) return { targetId: LOCAL_TARGET, fellBackFrom: chosen.name };
    throw new StorageRefused(
        `${chosen.name} could not take the ${input.what} (${attempt.detail}), and neither could this server (${here.detail}).`
    );
}

/** One attempt on one open storage. Disposes of it either way; leaves nothing
 *  behind when it fails, because an orphan on a NAS is somebody's disk quietly
 *  filling up. */
async function writeThrough(
    driver: StorageDriver,
    input: { folder: string; path: string; bytes: Uint8Array; mime: string }
): Promise<{ ok: boolean; detail: string }> {
    try {
        await driver.mkdir(input.folder).catch(() => undefined);
        const written = await withTimeout(
            driver.writeStream(input.path, streamOf(input.bytes), {
                mime: input.mime || "application/octet-stream",
                size: BigInt(input.bytes.length)
            }),
            PLACE_TIMEOUT_MS,
            "it stopped answering part-way through the file"
        );
        if (Number(written.size) !== input.bytes.length) {
            await driver.delete(input.path).catch(() => undefined);
            return {
                ok: false,
                detail: `it kept ${Number(written.size)} bytes of ${input.bytes.length}`
            };
        }

        const stream = await withTimeout(
            driver.readStream(input.path),
            PLACE_TIMEOUT_MS,
            "it would not open the file it had just taken"
        );
        const reader = stream.getReader();
        try {
            const { done, value } = await withTimeout(
                reader.read(),
                PLACE_TIMEOUT_MS,
                "it opened the file and then said nothing"
            );
            if (input.bytes.length > 0 && (done || !value?.length)) {
                await driver.delete(input.path).catch(() => undefined);
                return { ok: false, detail: "it took the file and gave back nothing" };
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        return { ok: true, detail: "" };
    } catch (error) {
        await driver.delete(input.path).catch(() => undefined);
        return { ok: false, detail: message(error) };
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes);
            controller.close();
        }
    });
}

/**
 * How long a storage that would not open is left alone.
 *
 * Reaching one that is off is not free: a connect against a host that is not
 * answering waits for the timeout, and paying that on every upload turns "the
 * share is unplugged" into "everything anybody sends takes ten seconds to reach
 * anybody" - which is what somebody on the other end experiences as a chat that
 * has stopped being live. So the first failure is the one that waits, and the
 * next minute of uploads goes straight to the disk that works.
 *
 * A minute, because the other side of this is a share that came back and is
 * still being skipped. Short enough that nobody notices, and the check on the
 * uploads screen clears it outright.
 */
const RETRY_AFTER_MS = 60_000;

/** When each storage last refused to open. In this process only: it is a
 *  latency shortcut, and a replica working it out for itself is correct. */
const FAILED = new Map<string, number>();

function failedRecently(targetId: string): boolean {
    const at = FAILED.get(targetId);
    if (at === undefined) return false;
    if (Date.now() - at < RETRY_AFTER_MS) return true;
    FAILED.delete(targetId);
    return false;
}

/** Stop skipping a storage. For the check on the uploads screen: an operator who
 *  has just watched it write, read and delete a file should not then wait out a
 *  minute of Polaris remembering it was broken. */
export function forgetStorageFailure(targetId: string): void {
    FAILED.delete(targetId);
}

/** The disk Polaris runs on, opened. */
async function here(localFolder: string): Promise<Omit<WritableTarget, "fellBackFrom">> {
    return {
        driver: await driverForTarget(LOCAL_TARGET, localFolder),
        targetId: LOCAL_TARGET,
        name: "this server"
    };
}

/**
 * A file name that is safe on every backend Polaris writes to.
 *
 * Windows, SMB and every archive tool disagree about what a name may contain, so
 * a stored name is reduced to the characters they all accept. The name somebody
 * typed is kept in the database and used on the way out, so nothing a person
 * reads is affected by this.
 */
export function safeName(name: string): string {
    const cleaned = name
        // An allowlist rather than a list of what to strip: the set of things
        // some filesystem objects to is open-ended, and the set that is safe
        // everywhere is short.
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^[.-]+/, "")
        .replace(/-{2,}/g, "-");
    return cleaned.slice(0, 120) || "file";
}

/**
 * Write a small file, read it back, and delete it.
 *
 * The check that would have answered a whole afternoon: a message with a
 * recording on it that everybody could see and nobody could open, because the
 * bytes went somewhere that took them and would not give them back. A write that
 * appears to succeed proves nothing on its own - a share that has gone away, a
 * directory inside a container that the next deploy replaces, a mount that
 * accepts writes into nothing all look exactly like working storage until
 * somebody asks for the file.
 *
 * So this asks for the file. It is the same three calls an upload and a download
 * make, in order, against the target actually in use.
 */
export async function checkStorageTarget(
    targetId: string,
    localFolder: string
): Promise<{ ok: boolean; detail: string }> {
    const path = `polaris/health/${crypto.randomUUID()}`;
    const written = new TextEncoder().encode("polaris storage check");

    let driver;
    try {
        driver = await driverForTarget(targetId, localFolder);
    } catch (error) {
        return { ok: false, detail: `Could not reach it: ${message(error)}` };
    }

    try {
        await driver.mkdir("polaris/health").catch(() => undefined);
        await driver.writeStream(
            path,
            new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(written);
                    controller.close();
                }
            }),
            { mime: "text/plain", size: BigInt(written.length) }
        );
    } catch (error) {
        return { ok: false, detail: `Wrote nothing: ${message(error)}` };
    }

    try {
        const reader = (await driver.readStream(path)).getReader();
        let read = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            read += value?.length ?? 0;
        }
        if (read !== written.length) {
            return {
                ok: false,
                detail: `Took the file and gave back ${read} bytes of ${written.length}.`
            };
        }
    } catch (error) {
        // The one that matters: the write said yes and the read says no. That is
        // exactly what an attachment that 404s looks like from the inside.
        return { ok: false, detail: `Took the file but would not give it back: ${message(error)}` };
    } finally {
        await driver.delete(path).catch(() => undefined);
        await driver.dispose().catch(() => undefined);
    }

    // It works. Whatever this instance remembered about it not working is out of
    // date as of a second ago, so the next upload goes to it rather than waiting
    // out the rest of the minute on the disk next door.
    forgetStorageFailure(targetId);
    return {
        ok: true,
        detail: `Wrote a file, read it back and removed it. ${await keeps(targetId, localFolder)}`
    };
}

/**
 * Whether what is written here will still be here next week.
 *
 * The check above proves the storage works *now*, and there is a way for that to
 * be true and for every file to disappear anyway: a folder inside the container
 * is replaced wholesale by the next deploy. The database survives it, so the
 * rows stay and point at bytes that are gone - which reaches somebody as an
 * attachment that opened yesterday and 404s today, with nothing broken anywhere
 * to find.
 *
 * Answered by asking the kernel: a path that is not on a mount of its own, in a
 * container, is on the container's own filesystem.
 */
async function keeps(targetId: string, localFolder: string): Promise<string> {
    if (targetId !== LOCAL_TARGET) return "";
    const root = `${loadEnv().POLARIS_DATA_DIR}/${localFolder}`;

    try {
        const { readFile } = await import("node:fs/promises");
        const inContainer = await readFile("/proc/1/cgroup", "utf8")
            .then((text) => /docker|containerd|kubepods/.test(text))
            .catch(() => false);
        if (!inContainer) return `Kept at ${root}.`;

        const mounts = await readFile("/proc/self/mountinfo", "utf8");
        const points = mounts
            .split(/\r?\n/)
            .map((line) => line.split(" ")[4] ?? "")
            .filter((point) => point && point !== "/");
        const onAVolume = points.some((point) => root === point || root.startsWith(`${point}/`));
        return onAVolume
            ? `Kept at ${root}, on a volume.`
            : `Kept at ${root}, which is inside the container: everything written here is lost the next time Polaris is deployed. Mount a volume there, or point this at a storage connection.`;
    } catch {
        // Not Linux, or a kernel that does not answer. The check above still
        // stands; this part simply has nothing to add.
        return `Kept at ${root}.`;
    }
}

/** Whatever a driver threw, as a line somebody can act on. */
function message(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
}
