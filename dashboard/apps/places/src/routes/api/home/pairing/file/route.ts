/**
 * A file uploaded at a connection's pairing step - the Philips Air+ app, for
 * the fan and heater cloud - read for what the pairing needs and thrown away.
 *
 * A route rather than an action because an action carries a megabyte and an app
 * is a hundred times that. The body is streamed to a scratch file with a name
 * nobody can guess, never held whole in memory, cut off past the connection's
 * own limit, read by the driver (`DevicePairing.file`), and deleted whatever
 * happens - nothing of it outlives the request. What comes back is a handle
 * to what was read, which stays on the server (`pairing-vault.ts`): the
 * browser hands it to the next poll and never sees the value.
 *
 * The same people who may connect an account may send one (`home.manage`), and
 * only from Polaris' own pages, as with an action.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { host } from "@polaris/app-host";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { placesT } from "../../../../../lib/i18n";
import { homeInstall } from "../../../../../lib/access";
import { HomeError } from "../../../../../lib/home-error";
import * as registry from "../../../../../lib/device-connections";
import { placesRefusalText } from "../../../../../lib/refusal-text";
import { readPairingFile } from "../../../../../lib/device-accounts";

const { apiUser } = host.apiSession;
const { sessionCan } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The same check an action makes before it runs. */
function sameOrigin(request: Request): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return false;
    const where = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    try {
        return new URL(origin).host === where;
    } catch {
        return false;
    }
}

class TooLarge extends Error {}

export async function POST(request: Request): Promise<Response> {
    const t = await placesT();
    const refuse = (status: number, message: string) =>
        Response.json({ error: message }, { status });

    if (!sameOrigin(request)) return refuse(403, t("refusals.noAccess"));
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "home.manage"))) return refuse(403, t("refusals.noAccess"));
    if (!(await homeInstall())) return refuse(404, t("refusals.notSetUp"));

    const connection = registry.deviceConnection(
        new URL(request.url).searchParams.get("connection") ?? ""
    );
    const limit = connection?.pairing?.file?.maxBytes;
    if (!connection || !limit) return refuse(404, t("refusals.cannotConnect"));
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > limit) return refuse(413, t("refusals.fileTooLarge"));
    if (!request.body) return refuse(400, t("refusals.fileEmpty"));

    const scratch = await mkdtemp(join(tmpdir(), "polaris-upload-"));
    try {
        const path = join(scratch, "upload");
        let received = 0;
        const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                received += chunk.length;
                done(received > limit ? new TooLarge() : null, chunk);
            }
        });
        try {
            await pipeline(
                Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
                counted,
                createWriteStream(path, { mode: 0o600 })
            );
        } catch (caught) {
            if (caught instanceof TooLarge) return refuse(413, t("refusals.fileTooLarge"));
            return refuse(400, t("refusals.fileEmpty"));
        }
        if (received === 0) return refuse(400, t("refusals.fileEmpty"));
        const state = await readPairingFile(connection.id, path);
        return Response.json({ state });
    } catch (caught) {
        if (caught instanceof HomeError) return refuse(422, placesRefusalText(t, caught.message));
        console.error("places: a pairing file could not be read", caught);
        return refuse(500, t("refusals.failed"));
    } finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
