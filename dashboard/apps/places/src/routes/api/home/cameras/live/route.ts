/**
 * Which cameras the relay is actually serving, for a wall that is waiting on
 * one.
 *
 * A route rather than the server action the wall asks first, because the wall
 * asks again on a timer for as long as a camera it should be showing is not
 * served - and an update renames every action under a tab left open, so a timer
 * calling one fails from then on and the tile stays on "Starting".
 *
 * The same reach as the action: a visitor lent a camera is a caller, and only
 * the cameras they reach are ever in the answer.
 */

import { host } from "@polaris/app-host";
import { homeInstall } from "../../../../../lib/access";
import { listCameras } from "../../../../../lib/cameras";
import { servedCameraIds } from "../../../../../lib/live";
import { onlyReachable, placesReach, reachesNothing } from "../../../../../lib/sharing";

const { apiUser } = host.apiSession;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const reach = await placesReach(user);
    if (reachesNothing(reach)) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    try {
        return Response.json(
            {
                live: await servedCameraIds(
                    onlyReachable(await listCameras(install.id), reach.everything || reach.cameras)
                )
            },
            { headers: { "cache-control": "no-store" } }
        );
    } catch (caught) {
        console.error("places: the live cameras could not be read", caught);
        return new Response("Unavailable", {
            status: 503,
            headers: { "cache-control": "no-store" }
        });
    }
}
