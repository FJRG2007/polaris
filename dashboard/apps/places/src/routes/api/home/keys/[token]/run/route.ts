/**
 * One press of a wall panel's automation button, through the panel's link. No
 * session: the token is the whole of the right, checked against the panel,
 * bounded and rate-limited in `guest-key`.
 *
 *   POST { automationId, where? }  ->  {} | { error, nearby? }
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { HomeError } from "../../../../../../lib/home-error";
import { placesT } from "../../../../../../lib/i18n";
import { placesRefusalText } from "../../../../../../lib/refusal-text";
import { runGuestAutomation } from "../../../../../../lib/guest-key";
import { NearbyRefusal, reportedLocation } from "../../../../../../lib/nearby";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
    automationId: z.string().uuid(),
    where: z.unknown().optional()
});

export async function POST(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const t = await placesT();
    const { token } = await params;
    const body = bodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) return Response.json({ error: t("panels.runFailed") }, { status: 400 });
    const ip = (await host.requestContext.clientIp()) ?? "unknown";
    try {
        await runGuestAutomation(
            String(token),
            body.data.automationId,
            reportedLocation(body.data.where),
            ip
        );
        return Response.json({});
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
        console.error("places: a guest link automation run failed", caught);
        return Response.json({ error: t("panels.runFailed") }, { status: 500 });
    }
}
