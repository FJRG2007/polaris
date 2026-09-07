/**
 * Bytes for a file that is not on the reader's machine.
 *
 * Two sources, shared by every screen in Polaris that accepts an attachment: a
 * file already on a storage this person can reach, and one at an address they
 * pasted. Both are the server copying bytes it can already get at, and neither
 * has any business travelling out to the browser and back - which is what
 * "download it out of your own Drive so you can upload it again" was.
 *
 * What is done with the bytes afterwards is each app's own business: mail keeps
 * them as a pending upload, chat as a message attachment, a task as a file on
 * the task. This only gets them, and it is the one place the authorization and
 * the ceilings live.
 */

import { normalizeRelPath } from "@polaris/core";
import { requireDriveDriver } from "@/lib/drive-authz";
import { follow, readCapped, safeUrl } from "@/lib/safe-fetch";

/** Said to the reader when something cannot be fetched. Never the underlying
 *  error: those name hosts and paths nobody asked to publish. */
export class AttachRefused extends Error {}

/** A file, in memory. */
export interface FetchedFile {
    readonly name: string;
    readonly type: string;
    readonly bytes: Uint8Array;
}

/**
 * A file on one of this reader's storages.
 *
 * Authorized the way every other read of that storage is - by the same guard,
 * on the same path - so a picker cannot reach further than the Drive screen
 * would let the same person reach by hand.
 */
export async function fileFromDrive(
    userId: string,
    connectionId: string,
    rawPath: string,
    maxBytes: number
): Promise<FetchedFile> {
    let path: string;
    try {
        path = normalizeRelPath(rawPath);
    } catch {
        throw new AttachRefused("That file could not be attached.");
    }

    const driver = await requireDriveDriver(userId, connectionId, path, "download").catch(() => null);
    if (!driver) throw new AttachRefused("That file is not yours to attach.");

    try {
        const stat = await driver.stat(path);
        if (stat.kind !== "file") throw new AttachRefused("That is a folder, not a file.");
        if (Number(stat.size) > maxBytes) throw new AttachRefused(tooBig());
        const bytes = await collect(await driver.readStream(path), maxBytes);
        if (!bytes) throw new AttachRefused(tooBig());
        return { name: path.split("/").at(-1) || "attachment", type: "", bytes };
    } finally {
        // The driver holds a pooled session and every exit has to give it back,
        // including the ones that threw.
        await driver.dispose().catch(() => undefined);
    }
}

/**
 * A file at an address somebody pasted.
 *
 * Fetched by Polaris rather than by the browser, through the same guard every
 * person-supplied address goes through: public addresses only, redirects
 * followed by hand and re-checked at each hop, a timeout, and a byte ceiling.
 * So a pasted address cannot be used to make this server read something on its
 * own network.
 */
export async function fileFromAddress(address: string, maxBytes: number): Promise<FetchedFile> {
    const target = safeUrl(address);
    if (!target) throw new AttachRefused("That address cannot be reached from here.");

    const response = await follow(target, "*/*");
    if (!response || response.status !== 200) {
        throw new AttachRefused("Nothing came back from that address.");
    }
    const bytes = await readCapped(response, maxBytes);
    if (!bytes) throw new AttachRefused(tooBig());

    return {
        name: nameFrom(response, target),
        type: (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "",
        bytes
    };
}

function tooBig(): string {
    return "That file is bigger than this will accept.";
}

/** What to call what came back: the name the server gave it, else the last part
 *  of the address, else something rather than nothing. */
function nameFrom(response: { headers: Headers }, target: URL): string {
    const disposition = response.headers.get("content-disposition") ?? "";
    const named = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition)?.[1];
    if (named) {
        try {
            return decodeURIComponent(named.replace(/"$/, "")).split(/[\\/]/).at(-1) || "attachment";
        } catch {
            return named.replace(/"$/, "");
        }
    }
    return decodeURIComponent(target.pathname.split("/").filter(Boolean).at(-1) ?? "") || "attachment";
}

/**
 * A stream read into memory, or nothing when it is longer than allowed.
 *
 * An attachment is held whole either way, so there is nothing to gain by
 * streaming past the ceiling and stopping at it is what keeps one enormous file
 * off this server's heap.
 *
 * Written for both shapes a driver can answer with, because they differ by
 * storage: the local one hands back a Node stream and the network ones a web
 * one.
 */
async function collect(stream: unknown, cap: number): Promise<Uint8Array | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    const add = (chunk: unknown): boolean => {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike as never);
        size += piece.length;
        if (size > cap) return false;
        chunks.push(piece);
        return true;
    };

    const web = stream as ReadableStream<Uint8Array>;
    if (typeof web?.getReader === "function") {
        const reader = web.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && !add(value)) {
                await reader.cancel().catch(() => undefined);
                return null;
            }
        }
        return new Uint8Array(Buffer.concat(chunks));
    }

    for await (const chunk of stream as AsyncIterable<Buffer | string>) {
        if (!add(chunk)) return null;
    }
    return new Uint8Array(Buffer.concat(chunks));
}
