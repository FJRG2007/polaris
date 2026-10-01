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
import { LocalDriver } from "@polaris/storage";
import { getSetting } from "@/lib/setting-store";
import type { StorageDriver } from "@polaris/storage";
import { getDriverForConnection } from "@/lib/storage-service";
import { isPersonalKind, LOCAL_TARGET, PERSONAL_KIND, withTimeout } from "@polaris/core";

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

    if (target.id === LOCAL_TARGET) {
        return {
            driver: await driverForTarget(target.id, localFolder),
            targetId: target.id,
            name: target.name,
            fellBackFrom: null
        };
    }

    try {
        const opened = {
            driver: await openWithin(target, localFolder),
            targetId: target.id,
            name: target.name,
            fellBackFrom: null
        };
        FAILED.delete(target.id);
        if (DOWN.delete(target.id)) {
            void announce((alert) => alert.storageAnswered(target.id));
            // Back: what was kept here while it was away can go home now.
            void import("@/lib/storage-returns")
                .then((returns) => returns.returnFallbackFiles({ only: target.id }))
                .catch(() => undefined);
        }
        return opened;
    } catch (error) {
        console.error(`storage: ${target.name} could not be opened for writing:`, error);
        markUnreachable(target.id, target.name);
        return { ...(await here(localFolder)), fellBackFrom: target.name };
    }
}

/**
 * Remember a storage as gone and tell the administrators.
 *
 * Not only for one that would not open: a share whose mount is still trusted can
 * open and then go quiet on the write, and unless that is remembered too, every
 * upload and every "Try again" goes back to it and waits out the stall again.
 */
function markUnreachable(id: string, name: string): void {
    if (id === LOCAL_TARGET) return;
    FAILED.set(id, Date.now());
    DOWN.add(id);
    void announce((alert) => alert.reportStorageUnreachable({ id, name }));
}

/** `openForWriting` for a file on its way: when not even this server will open,
 *  that is said as a storage refusing the file rather than as whatever the disk
 *  threw. */
async function openOrRefuse(
    target: UploadTarget,
    localFolder: string,
    what: string
): Promise<WritableTarget> {
    try {
        return await openForWriting(target, localFolder);
    } catch (error) {
        throw new StorageRefused(
            `this server could not take the ${what}: ${message(error)}`,
            null,
            false,
            { cause: error }
        );
    }
}

/**
 * A file that was meant for a storage and landed on this server instead is
 * listed, so it is moved there once the storage answers again
 * (`lib/storage-returns`). Not waited on: the upload already succeeded, and a
 * file that is not listed only stays readable where it is.
 */
function listForReturn(
    input: { target: UploadTarget; localFolder: string; path: string },
    landedOn: string
): void {
    if (landedOn !== LOCAL_TARGET || input.target.id === LOCAL_TARGET) return;
    void import("@/lib/storage-returns")
        .then((returns) => returns.recordFallback(input.target.id, input.localFolder, input.path))
        .catch(() => undefined);
}

/**
 * How long a storage gets to open before the upload stops waiting for it.
 *
 * Opening one is a request to the host daemon for its kernel mount and then, when
 * that fails, a userspace connect - and a NAS that is switched off answers neither
 * quickly: the mount helper waits out the kernel's own retries and nothing on this
 * side used to put a limit on it. That was the whole of "the picture says 0
 * seconds left and never arrives": the bytes were sent, and the request sat
 * behind a connect that never came back. Past this, the file goes to this server
 * instead.
 */
const OPEN_TIMEOUT_MS = 20_000;

/** `driverForTarget` with a deadline. A driver that turns up after it has been
 *  given up on is closed again rather than left holding a session. */
async function openWithin(target: UploadTarget, localFolder: string): Promise<StorageDriver> {
    const opening = driverForTarget(target.id, localFolder);
    try {
        return await withTimeout(opening, OPEN_TIMEOUT_MS, `${target.name} did not answer in time`);
    } catch (error) {
        void opening.then((late) => late.dispose()).catch(() => undefined);
        throw error;
    }
}

/** Tell the administrators, without making the upload wait for it or fail with it.
 *  Loaded when needed: this module is imported by code that runs where the
 *  notification layer does not. */
async function announce(
    say: (alert: typeof import("@/lib/storage-alert")) => Promise<void> | void
): Promise<void> {
    try {
        await say(await import("@/lib/storage-alert"));
    } catch {
        // The upload is what matters here; the log line above already has it.
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
    constructor(
        message: string,
        /** The storage that said no, by the name an administrator gave it. */
        public readonly storage: string | null = null,
        /** Whether it said no by not answering at all - switched off, unplugged,
         *  off the network - as opposed to answering and refusing the file. The
         *  two are different sentences for whoever is sending it. */
        public readonly unreachable = false,
        options?: { cause?: unknown }
    ) {
        super(message, options);
        this.name = "StorageRefused";
    }
}

/** What a storage that is not there at all says, across the drivers and the
 *  network beneath them, as opposed to one that answered and refused. */
const NOT_THERE =
    /EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|connection_failed|socket closed|timed out|did not answer|stopped answering|Host is down/i;

/** Whether an error means the storage is not reachable, read through its causes. */
export function isUnreachable(error: unknown, depth = 0): boolean {
    if (depth > 4 || error === null || typeof error !== "object") return false;
    if (error instanceof StorageRefused && error.unreachable) return true;
    const said = error as { message?: unknown; code?: unknown; cause?: unknown };
    const words = `${typeof said.code === "string" ? said.code : ""} ${typeof said.message === "string" ? said.message : ""}`;
    return NOT_THERE.test(words) || isUnreachable(said.cause, depth + 1);
}

/** How long one file may take to be written and read back before the storage is
 *  treated as gone. Generous by an order of magnitude for anything Polaris puts
 *  through here over a local network, and short enough that a share which has
 *  stopped answering falls through while somebody is still on the screen. */
const PLACE_TIMEOUT_MS = 60_000;

/**
 * The rest of the server's budget for one file, kept small enough that every
 * step after the last byte - open, make the folder, the storage's close, reading
 * the file back, cleaning up - adds up to well under `ANSWER_WITHIN_MS`, the
 * time the sender's screen waits for an answer. A save that lands after the
 * screen has said "no answer" is a duplicate on the next try.
 */
const MKDIR_TIMEOUT_MS = 15_000;
const READ_BACK_TIMEOUT_MS = 30_000;
const CLEANUP_TIMEOUT_MS = 5_000;

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
    const chosen = await openOrRefuse(input.target, input.localFolder, input.what);
    const attempt = await writeThrough(chosen.driver, input);
    if (attempt.ok) {
        listForReturn(input, chosen.targetId);
        return { targetId: chosen.targetId, fellBackFrom: chosen.fellBackFrom };
    }

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
    if (NOT_THERE.test(attempt.detail)) markUnreachable(chosen.targetId, chosen.name);

    // Opening this server can fail too - a data directory that is not writable -
    // and that throw has to arrive as the same sentence as any other refusal.
    // Raw, it reads as a bug in Polaris rather than as two disks saying no.
    const here = await openForWriting(
        { id: LOCAL_TARGET, name: "this server", automatic: true },
        input.localFolder
    )
        .then((local) => writeThrough(local.driver, input))
        .catch((error: unknown) => ({ ok: false, detail: message(error) }));
    if (here.ok) {
        listForReturn(input, LOCAL_TARGET);
        return { targetId: LOCAL_TARGET, fellBackFrom: chosen.name };
    }
    throw new StorageRefused(
        `${chosen.name} could not take the ${input.what} (${attempt.detail}), and neither could this server (${here.detail}).`,
        chosen.name,
        NOT_THERE.test(attempt.detail)
    );
}

/**
 * The same thing for a file nobody is holding: bytes straight from a request into
 * the storage.
 *
 * `placeFile` above is for a file this process has in hand, and it can afford
 * every guarantee because it can write the same bytes twice. A stream cannot:
 * once a request body has been read it is gone, so the storage that was chosen is
 * the storage that gets it, and a share that fails halfway is a failed upload
 * rather than a quiet fallback. What is kept from `placeFile` is what still
 * holds - the choice is made *before* the body is touched, so an unplugged NAS is
 * still skipped rather than written to, and the file is read back afterwards to
 * prove the storage will give it up again.
 *
 * There is no overall timeout, deliberately. A file large enough to be streamed
 * legitimately takes minutes, and a clock over the whole write would cut off the
 * uploads this exists for. What bounds it is the request: if the sender goes
 * away, the body ends and the write ends with it.
 *
 * `size` is what the storage says it kept, which is the only number worth
 * recording - a size the client declared is a size the client could understate.
 */
export async function streamFile(input: {
    readonly target: UploadTarget;
    readonly localFolder: string;
    /** Made if it is not there. */
    readonly folder: string;
    readonly path: string;
    readonly body: ReadableStream<Uint8Array>;
    readonly mime: string;
    /** What the sender said it weighs, for drivers that need a length up front -
     *  a chunked upload API cannot start without one. Never trusted as the
     *  stored size. */
    readonly declared?: number;
    /** What to call this kind of file in a log line. */
    readonly what: string;
}): Promise<{ targetId: string; size: number; fellBackFrom: string | null }> {
    const chosen = await openOrRefuse(input.target, input.localFolder, input.what);
    const watched = watchStream(input.body);
    try {
        await withTimeout(
            chosen.driver.mkdir(input.folder).catch(() => undefined),
            MKDIR_TIMEOUT_MS,
            "it stopped answering before the file could start"
        );
        const written = await watched.within(
            chosen.driver.writeStream(input.path, watched.body, {
                mime: input.mime || "application/octet-stream",
                ...(input.declared !== undefined && input.declared > 0
                    ? { size: BigInt(input.declared) }
                    : {})
            }),
            STALL_MS
        );

        // It took the file. Whether it will give it back is a different question,
        // and the one that has cost people their uploads: a share that has gone
        // away, a mount that accepts writes into nothing and a handle still held
        // open all stat perfectly and refuse the read.
        if (Number(written.size) > 0 && !(await givesBack(chosen.driver, input.path))) {
            throw new StorageRefused(
                `${chosen.name} took the ${input.what} and gave back nothing.`,
                chosen.targetId === LOCAL_TARGET ? null : chosen.name
            );
        }

        listForReturn(input, chosen.targetId);
        return {
            targetId: chosen.targetId,
            size: Number(written.size),
            fellBackFrom: chosen.fellBackFrom
        };
    } catch (error) {
        // A write that stopped part-way leaves a truncated file under a name that
        // reads like a whole one. Not waited on for ever: the storage that just
        // failed is the one being asked.
        await discard(chosen.driver, input.path);
        if (error instanceof StorageRefused) throw error;
        const unreachable = isUnreachable(error);
        if (unreachable) markUnreachable(chosen.targetId, chosen.name);
        // Said as the storage's failure, by its name: a caller can then tell the
        // sender which disk is not there instead of passing on a socket error.
        throw new StorageRefused(
            `${chosen.name} could not take the ${input.what}: ${message(error)}`,
            chosen.targetId === LOCAL_TARGET ? null : chosen.name,
            unreachable,
            { cause: error }
        );
    } finally {
        void chosen.driver.dispose().catch(() => undefined);
    }
}

/**
 * How long a streamed write may go without a single byte moving before it is
 * given up on.
 *
 * Not a clock over the whole upload - a file large enough to be streamed takes
 * minutes, and that is fine - but over silence. A share that went away part-way,
 * or one whose session is half-dead and accepts a connection it then never
 * finishes, holds the request with nothing moving; so does a write whose bytes
 * have all gone and whose close the storage never answers. Either way the sender
 * is looking at a bar that has stopped, and a minute of nothing is an answer.
 */
const STALL_MS = 60_000;

/**
 * A body that reports when it last moved, and a way to give up on a write that
 * has stopped.
 *
 * The clock starts again on every chunk the storage takes, and once the body has
 * ended it keeps running for the storage's own close: that last wait is where a
 * dead share actually hangs, because the bytes were already in a buffer.
 */
function watchStream(source: ReadableStream<Uint8Array>): {
    body: ReadableStream<Uint8Array>;
    within<T>(write: Promise<T>, idleMs: number): Promise<T>;
} {
    let last = Date.now();
    const reader = source.getReader();
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            const { done, value } = await reader.read();
            last = Date.now();
            if (done) controller.close();
            else controller.enqueue(value);
        },
        cancel(reason) {
            return reader.cancel(reason);
        }
    });
    return {
        body,
        within<T>(write: Promise<T>, idleMs: number): Promise<T> {
            last = Date.now();
            return new Promise<T>((resolve, reject) => {
                const timer = setInterval(
                    () => {
                        if (Date.now() - last < idleMs) return;
                        clearInterval(timer);
                        // Ends the request body as well, so a driver still waiting on
                        // it is woken with an error rather than left parked.
                        void reader.cancel("stalled").catch(() => undefined);
                        reject(new Error("it stopped answering part-way through the file"));
                    },
                    Math.min(1_000, idleMs)
                );
                if (typeof timer.unref === "function") timer.unref();
                write.then(
                    (value) => {
                        clearInterval(timer);
                        resolve(value);
                    },
                    (error: unknown) => {
                        clearInterval(timer);
                        reject(error);
                    }
                );
            });
        }
    };
}

/** One attempt on one open storage. Disposes of it either way; leaves nothing
 *  behind when it fails, because an orphan on a NAS is somebody's disk quietly
 *  filling up. */
async function writeThrough(
    driver: StorageDriver,
    input: { folder: string; path: string; bytes: Uint8Array; mime: string }
): Promise<{ ok: boolean; detail: string }> {
    try {
        await withTimeout(
            driver.mkdir(input.folder).catch(() => undefined),
            MKDIR_TIMEOUT_MS,
            "it stopped answering before the file could start"
        );
        const written = await withTimeout(
            driver.writeStream(input.path, streamOf(input.bytes), {
                mime: input.mime || "application/octet-stream",
                size: BigInt(input.bytes.length)
            }),
            PLACE_TIMEOUT_MS,
            "it stopped answering part-way through the file"
        );
        if (Number(written.size) !== input.bytes.length) {
            await discard(driver, input.path);
            return {
                ok: false,
                detail: `it kept ${Number(written.size)} bytes of ${input.bytes.length}`
            };
        }

        if (input.bytes.length > 0 && !(await givesBack(driver, input.path))) {
            await discard(driver, input.path);
            return { ok: false, detail: "it took the file and gave back nothing" };
        }
        return { ok: true, detail: "" };
    } catch (error) {
        await discard(driver, input.path);
        return { ok: false, detail: message(error) };
    } finally {
        void driver.dispose().catch(() => undefined);
    }
}

/**
 * Whether a file just written comes back: opened and its first bytes read, under
 * one deadline between them so a storage that answers each step slowly cannot
 * spend a full timeout on each.
 */
async function givesBack(driver: StorageDriver, path: string): Promise<boolean> {
    const deadline = Date.now() + READ_BACK_TIMEOUT_MS;
    const stream = await withTimeout(
        driver.readStream(path),
        READ_BACK_TIMEOUT_MS,
        "it would not open the file it had just taken"
    );
    const reader = stream.getReader();
    try {
        const { done, value } = await withTimeout(
            reader.read(),
            Math.max(1, deadline - Date.now()),
            "it opened the file and then said nothing"
        );
        return !done && Boolean(value?.length);
    } finally {
        await withTimeout(reader.cancel(), CLEANUP_TIMEOUT_MS, "cancel").catch(() => undefined);
    }
}

/** Remove what a failed write left, without waiting for ever on the storage that
 *  just failed. */
async function discard(driver: StorageDriver, path: string): Promise<void> {
    await withTimeout(driver.delete(path), CLEANUP_TIMEOUT_MS, "delete").catch(() => undefined);
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

/** The storages last seen not opening, until one opens again. Apart from FAILED,
 *  which forgets on a clock: this is what says an outage has ended. */
const DOWN = new Set<string>();

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
