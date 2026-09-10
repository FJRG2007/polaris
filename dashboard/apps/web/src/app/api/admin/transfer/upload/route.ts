/**
 * Receive an instance export to import, streamed to disk as it arrives.
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

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The largest file taken: far past any instance, short of filling a disk. */
const MAX_BYTES = 50 * 1024 ** 3;

export async function POST(request: Request): Promise<Response> {
    const user = await apiAdmin();
    if (user instanceof Response) return user;
    if (request.headers.get("x-polaris-transfer") !== "1") return new Response("Missing header", { status: 400 });
    if (!request.body) return Response.json({ error: "No file was sent" }, { status: 400 });
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_BYTES) return Response.json({ error: "That file is too large" }, { status: 413 });

    const { id, path } = await newTransferFile();
    let received = 0;
    try {
        await pipeline(
            Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
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
        return Response.json({ error: "The file did not arrive whole. Try again." }, { status: 400 });
    }
    return Response.json({ id, bytes: received });
}
