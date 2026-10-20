/**
 * One press on a door handed out as a link. No session: the link's token is
 * the whole of the right, checked, bounded and rate-limited in `guest-key`.
 *
 *   POST { action, where? }  ->  { device } | { error, nearby? }
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { HomeError } from "../../../../../lib/home-error";
import { placesT } from "../../../../../lib/i18n";
import { placesRefusalText } from "../../../../../lib/refusal-text";
import { pressGuestKey } from "../../../../../lib/guest-key";
import { DEVICE_ACTIONS } from "../../../../../lib/device-kinds";
import { NearbyRefusal, reportedLocation } from "../../../../../lib/nearby";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    action: z.enum(DEVICE_ACTIONS),
    where: z.unknown().optional()
});

export async function POST(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const t = await placesT();
    const { token } = await params;
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: t("refusals.deviceCannot") }, { status: 400 });
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    try {
        const device = await pressGuestKey(
            String(token),
            body.data.action,
            reportedLocation(body.data.where),
            ip
        );
        return Response.json({ device });
    } catch (caught) {
        if (caught instanceof HomeError) {
            return Response.json(
                {
                    error: placesRefusalText(t, caught.message),
                    ...(caught instanceof NearbyRefusal ? { nearby: caught.verdict } : {})
                },
                { status: 403 }
            );
        }
        console.error("places: a guest link press failed", caught);
        return Response.json({ error: t("refusals.deviceCannot") }, { status: 500 });
    }
}
