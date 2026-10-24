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
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const t = await placesT();
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    // A room's or a panel's link says which of its cameras; a camera's link needs nothing.
    const asked = new URL(request.url).searchParams.get("camera") ?? undefined;
    const opened = await openGuestWatch(String((await params).token), ip, Date.now(), asked);
    if (opened.ok) return Response.json({ watch: opened.watch });
    const words = {
        tooMany: t("guestCamera.tooMany"),
        private: t("guestCamera.private"),
        closed: t("guestCamera.closed")
    } as const;
    return Response.json(
        { error: words[opened.error], code: opened.error },
        { status: opened.error === "tooMany" ? 429 : opened.error === "private" ? 423 : 404 }
    );
}
