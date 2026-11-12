/**
 * The weather at a wall panel's place, for a signed-in wall. A route rather
 * than a server action because the wall asks again on a timer for as long as
 * it is open, and an update renames every action under a tab left open.
 *
 *   GET  ->  { located, weather }
 */

import { z } from "zod";
import { host } from "@polaris/app-host";
import { homeInstall } from "../../../../../../lib/access";
import { panelWeather } from "../../../../../../lib/panel-weather";

const { apiUser } = host.apiSession;
const { sessionCan } = host.session;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const id = z.string().uuid().safeParse((await params).id);
    if (!id.success) return new Response("Not found", { status: 404 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });
    const answer = await panelWeather(install.id, id.data);
    if (!answer) return new Response("Not found", { status: 404 });
    return Response.json(answer, { headers: { "cache-control": "private, max-age=300" } });
}
