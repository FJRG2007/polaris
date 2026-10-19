/**
 * Receive an instance export to import, streamed to disk as it arrives - or,
 * when the body is JSON naming where it lies on one of the administrator's
 * storages, read from there the same way.
 *
 * Admin-only. It must carry the `x-polaris-transfer` header, which a form on
 * another site cannot send without the browser asking this one first - so a page
 * elsewhere cannot push a file here on an administrator's behalf. Nothing is read
 * or imported here; the file waits under a random id for the import to name.
 */

import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";
import { apiAdmin } from "@/lib/api-session";
import { pipeline } from "node:stream/promises";
import { dropTransferFile, newTransferFile } from "@/lib/instance-transfer/files";
import { readerWords } from "@/lib/i18n/reader-words";
import { AttachRefused, openedDriveBody, type OpenedFile } from "@/lib/attachments/from-elsewhere";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest file taken: far past any instance, short of filling a disk. */
const MAX_BYTES = 50 * 1024 ** 3;

export async function POST(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    if (request.headers.get("x-polaris-transfer") !== "1") return new Response("Missing header", { status: 400 });
    if (!request.body) return Response.json({ error: (await readerWords("api"))("errors.noFileSent") }, { status: 400 });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return Response.json({ error: (await readerWords("api"))("errors.fileTooLarge") }, { status: 413 });

    let opened: OpenedFile | null;
    try {
        opened = await openedDriveBody(request, user.id, MAX_BYTES);
    } catch (caught) {
        const error = caught instanceof AttachRefused ? caught.message : (await readerWords("api"))("errors.fileIncomplete");
        return Response.json({ error }, { status: 400 });
    }
    const body = opened?.body ?? request.body;

    const { id, path } = await newTransferFile();
    let received = 0;
    try {
        await pipeline(
            Readable.fromWeb(body as import("node:stream/web").ReadableStream),
            async function* (source) {
                for await (const chunk of source) {
                    received += (chunk as Buffer).length;
                    if (received > MAX_BYTES) throw new Error("too large");
                    yield chunk;
                }
            },
            createWriteStream(path)
        );
    } catch {
        await dropTransferFile(id);
        return Response.json({ error: (await readerWords("api"))("errors.fileIncomplete") }, { status: 400 });
    } finally {
        await opened?.done();
    }
    return Response.json({ id, bytes: received });
}
