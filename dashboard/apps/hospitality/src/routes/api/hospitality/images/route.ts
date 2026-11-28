/**
 * Pictures of products and categories. POST takes one picture the crop dialog
 * already cut square and re-encoded (WebP), and answers with the address the
 * product keeps; GET serves it back.
 *
 * Written through the placement every upload in Polaris uses, so a venue with
 * a NAS puts its pictures there with nothing to wire. The address carries the
 * storage it landed on and a random id, never a path, so a GET cannot be
 * pointed at any other file. A picture never changes once written (a new one
 * gets a new id), so it is cached for a year.
 */

import { randomUUID } from "node:crypto";
import { host } from "@polaris/app-host";
import { sniffImage } from "../../../../model/image";

const { driverForTarget, placeFile, resolveTargetChoice } = host.storageTarget;

const ROOT = "polaris/hospitality/images";
const LOCAL_FOLDER = "hospitality";
/** A 512 px WebP is well under this; anything larger did not come from the cropper. */
const MAX_BYTES = 2 * 1024 * 1024;
const KEY = /^([a-z0-9-]{1,64}):([0-9a-f-]{36})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pathOf(id: string): string {
    return `${ROOT}/${id}.img`;
}

export async function POST(request: Request): Promise<Response> {
    try {
        await host.session.requirePermission("hospitality.manage");
    } catch {
        return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_BYTES) return Response.json({ error: "tooLarge" }, { status: 413 });
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_BYTES) return Response.json({ error: "tooLarge" }, { status: 413 });
    const mime = sniffImage(bytes);
    if (!mime) return Response.json({ error: "notImage" }, { status: 415 });
    const id = randomUUID();
    try {
        const placed = await placeFile({
            target: await resolveTargetChoice(null),
            localFolder: LOCAL_FOLDER,
            folder: ROOT,
            path: pathOf(id),
            bytes,
            mime,
            what: "menu picture"
        });
        return Response.json({ url: `/api/hospitality/images?i=${encodeURIComponent(`${placed.targetId}:${id}`)}` });
    } catch (error) {
        console.error("hospitality: a menu picture could not be stored:", error);
        return Response.json({ error: "storage" }, { status: 503 });
    }
}

export async function GET(request: Request): Promise<Response> {
    try {
        await host.session.requirePermission("hospitality.use");
    } catch {
        return new Response(null, { status: 401 });
    }
    const match = KEY.exec(new URL(request.url).searchParams.get("i") ?? "");
    const targetId = match?.[1];
    const id = match?.[2];
    if (!targetId || !id || !UUID.test(id)) return new Response(null, { status: 404 });
    let driver: Awaited<ReturnType<typeof driverForTarget>> | null = null;
    try {
        driver = await driverForTarget(targetId, LOCAL_FOLDER);
        const stream = await driver.readStream(pathOf(id));
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        return new Response(bytes, {
            headers: {
                "content-type": sniffImage(bytes) ?? "application/octet-stream",
                "cache-control": "private, max-age=31536000, immutable",
                "x-content-type-options": "nosniff"
            }
        });
    } catch (error) {
        console.error(`hospitality: could not read menu picture ${id} from ${targetId}:`, error);
        return new Response(null, { status: 404 });
    } finally {
        await driver?.dispose?.().catch(() => undefined);
    }
}
