/**
 * What the vision worker should be watching.
 *
 * Asked on a slow loop by every worker the house has. The answer carries stream
 * addresses on the relay and never a camera's own address or password: a worker
 * is a thing that runs on a machine somewhere, and it gets the least it can do
 * its job with.
 */

import { homeInstall } from "@/lib/home/access";
import { assignmentsFor, authorizeWorker } from "@/lib/home/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const worker = await authorizeWorker(request);
    if (!worker) return Response.json({ error: "Not authorized." }, { status: 401 });
    const install = await homeInstall();
    if (!install) return Response.json({ assignments: [] });
    return Response.json({ assignments: await assignmentsFor(install.id) });
}
