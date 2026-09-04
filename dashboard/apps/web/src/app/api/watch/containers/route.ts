/**
 * Every container on every reachable server, as JSON.
 *
 * This is what keeps Watch from blocking on Docker. A container has no stored
 * series to read - the figures only exist by asking each daemon for a listing and
 * then a stats sample per container, and the daemon holds every one of those open
 * for about a second while it takes the second CPU sample it needs. Held in front
 * of a render that is a navigation that hangs for as long as the machines take to
 * answer; behind a fetch it is a screen that is already there, filling in.
 *
 * Node runtime because the Docker transports and Prisma need it.
 */

import { getWatchContainers } from "@/lib/watch-overview-service";
import { apiPermission } from "@/lib/api-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;
    const containers = await getWatchContainers(user.id);
    return Response.json({ containers });
}
