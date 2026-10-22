/**
 * Opening a camera handed out as a link. No session: the token is the right.
 * One open is one use of the link (see `lib/guest-camera`); the watch id it
 * answers with is what the picture routes under it take.
 *
 *   POST  ->  { watch } | { error }
 */

import { host } from "@polaris/app-host";
import { placesT } from "../../../../../../lib/i18n";
import { openGuestWatch } from "../../../../../../lib/guest-camera";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
    _request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const t = await placesT();
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    const opened = await openGuestWatch(String((await params).token), ip);
    if (opened.ok) return Response.json({ watch: opened.watch });
    return Response.json(
        {
            error:
                opened.error === "tooMany" ? t("guestCamera.tooMany") : t("guestCamera.closed")
        },
        { status: opened.error === "tooMany" ? 429 : 404 }
    );
}
