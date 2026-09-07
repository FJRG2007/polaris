/**
 * A file the picker chose, handed to a screen that stages its own uploads.
 *
 * Mail copies a chosen file straight into its own store and the bytes never
 * leave the server, which is the right shape and needs no route. Chat and the
 * task files stage a `File` in the browser and upload it when the message or the
 * comment is sent, and rewriting both to take a reference instead would be a
 * bigger change than the feature is worth. So they get the bytes here.
 *
 * It is still Polaris that fetches: a pasted address is followed by this server
 * through the same guard as everything else, so the site it points at learns
 * that a server asked and nothing about the reader. A file on a storage is
 * authorized on the same path the Drive screen would authorize it on.
 */

import { apiUser } from "@/lib/api-session";
import { AttachRefused, fileFromAddress, fileFromDrive } from "@/lib/attachments/from-elsewhere";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** As much as anything staged in a browser should be. Each screen still applies
 *  its own ceiling when it uploads. */
const MAX_BYTES = 100 * 1024 * 1024;

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;

    const url = new URL(request.url);
    const address = url.searchParams.get("url") ?? "";
    const connectionId = url.searchParams.get("c") ?? "";
    const path = url.searchParams.get("p") ?? "";

    try {
        const file = address
            ? await fileFromAddress(address, MAX_BYTES)
            : connectionId
              ? await fileFromDrive(user.id, connectionId, path, MAX_BYTES)
              : null;
        if (!file) return Response.json({ error: "Nothing was asked for." }, { status: 400 });

        return new Response(new Uint8Array(file.bytes), {
            headers: {
                "content-type": file.type || "application/octet-stream",
                "content-length": String(file.bytes.length),
                // The name travels in a header the browser will let script read,
                // because the screen staging this has to call the file something.
                "x-polaris-filename": encodeURIComponent(file.name),
                "access-control-expose-headers": "x-polaris-filename",
                "x-content-type-options": "nosniff",
                "cache-control": "private, no-store"
            }
        });
    } catch (caught) {
        if (caught instanceof AttachRefused) {
            return Response.json({ error: caught.message }, { status: 400 });
        }
        return Response.json({ error: "That file could not be fetched." }, { status: 500 });
    }
}
