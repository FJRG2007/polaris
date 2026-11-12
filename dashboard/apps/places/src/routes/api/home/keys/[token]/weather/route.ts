/**
 * The weather at a wall panel's place, through the panel's link. No session:
 * the token is the right, and only a live panel link reaches it. The answer
 * never carries the place's coordinates.
 *
 *   GET  ->  { located, weather }
 */

import { host } from "@polaris/app-host";
import { homeInstall } from "../../../../../../lib/access";
import { panelWeather } from "../../../../../../lib/panel-weather";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const reached = await host.accessGrants.linkReach(String(token));
    if (!reached || reached.subjectType !== "place.panel" || reached.standing !== "live")
        return new Response("Not found", { status: 404 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });
    const answer = await panelWeather(install.id, reached.subjectId);
    if (!answer) return new Response("Not found", { status: 404 });
    return Response.json(answer, { headers: { "cache-control": "private, max-age=300" } });
}
