/**
 * The knock: somebody tried to join a server that is not running.
 *
 * mc-router reports it here (`AUTO_SCALE_WEBHOOK_URL`) and then holds the player's
 * connection open, retrying the backend until it answers. Polaris decides whether
 * to start the server; the router is never given Docker, a token or any authority
 * of its own.
 *
 * Who may call it. The router reaches the dashboard inside the stack's own
 * network, which deployed apps are deliberately not on, and a request that came
 * through the edge always carries the forwarded headers Traefik adds. So a knock
 * that names a hop is refused: that is a caller from outside, and the answer to
 * them is not "which of these names exists".
 *
 * What a caller who got past that could do is start a server whose owner asked
 * for exactly that - never stop one, never reach a server that is not routed, and
 * never one the schedule is currently keeping down. Rate limited per name, since
 * a start is a machine waking up.
 *
 * The answer is the same shape whatever happened. The router only needs to know
 * the knock was taken; which name exists here is not its business, and saying so
 * would make this a way to enumerate them.
 */

import { z } from "zod";
import { wakeForJoin } from "../../../../lib/minecraft/wake-service";
import { host } from "@polaris/app-host";

const { rateLimit } = host.rateLimitService;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The router sends a short JSON object and nothing else. */
const MAX_BODY = 1024;

/** How many knocks one name may make in a minute. A client that gave up and
 *  reconnected is normal; a hundred of them is not a player. */
const WAKE_LIMIT = 6;
const WAKE_WINDOW_MS = 60_000;

/** What mc-router posts. `up` is a connection to a backend that is down; `down`
 *  is its own idle timer, which Polaris does not act on - the schedule sweep is
 *  what knows whether anybody is playing. */
const BODY = z.object({
    action: z.enum(["up", "down"]),
    serverAddress: z.string().trim().min(1).max(253),
    backend: z.string().trim().max(120).optional()
});

const taken = (): Response =>
    Response.json({ ok: true }, { status: 200, headers: { "cache-control": "no-store" } });

/** Whether this request came through the edge, which the router's never does. */
function fromOutside(request: Request): boolean {
    return Boolean(
        request.headers.get("x-forwarded-for") ||
            request.headers.get("x-forwarded-host") ||
            request.headers.get("x-real-ip")
    );
}

export async function POST(request: Request): Promise<Response> {
    if (fromOutside(request)) return new Response("Not found", { status: 404 });

    const text = await request.text();
    if (text.length > MAX_BODY) return new Response(null, { status: 413 });
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        return Response.json({ error: "invalid" }, { status: 400 });
    }
    const body = BODY.safeParse(json);
    if (!body.success) return Response.json({ error: "invalid" }, { status: 400 });
    if (body.data.action !== "up") return taken();

    const name = body.data.serverAddress.toLowerCase();
    const allowed = await rateLimit(`mc-wake:${name}`, WAKE_LIMIT, WAKE_WINDOW_MS);
    if (!allowed.ok) return taken();

    await wakeForJoin(name).catch(() => undefined);
    return taken();
}
