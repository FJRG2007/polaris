/**
 * What services print, pushed as they print it.
 *
 * Every container of every service named - each replica its own follow - read
 * from a short tail back and then as it writes, and sent in small batches that
 * say which service and which container each line came from. The follows are
 * tied to the connection: when the reader goes, the host stops them.
 *
 * Events:
 *   following  { serviceId, containers }      once a service's containers are known
 *   lines      [{ serviceId, container, stamp, text }]
 *   ended      { serviceId, container, reason } a container's output stopped
 *   done       {}                               nothing is left to follow
 *
 * A stream that reaches `done` is closed from here; the reader decides whether
 * to open another (a deploy replaces the container, so the next one follows the
 * new release).
 */

import { z } from "zod";
import { apiPermission } from "@/lib/api-session";
import { followRuntimeLogs, readableServices } from "@/lib/deploy/runtime-logs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How often the connection says it is still there while a service is quiet. */
const BEAT_MS = 15_000;

const QuerySchema = z.object({
    services: z
        .string()
        .transform((raw) =>
            raw
                .split(",")
                .map((id) => id.trim())
                .filter(Boolean)
        )
        .pipe(z.array(z.string().uuid()).min(1).max(20)),
    tail: z.coerce.number().int().min(0).max(1000).default(200)
});

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few seconds
    // against a session that is gone.
    const user = await apiPermission("deploy.read");
    if (user instanceof Response) return user;

    const url = new URL(request.url);
    const parsed = QuerySchema.safeParse({
        services: url.searchParams.get("services") ?? "",
        tail: url.searchParams.get("tail") ?? undefined
    });
    if (!parsed.success)
        return Response.json({ error: "Name the services to follow." }, { status: 400 });

    const services = await readableServices(user.id, parsed.data.services);
    if (services.length === 0)
        return Response.json({ error: "Service not found" }, { status: 404 });

    const encoder = new TextEncoder();
    const abort = new AbortController();
    let beat: ReturnType<typeof setInterval> | null = null;
    let closed = false;

    function stop(): void {
        closed = true;
        if (beat) clearInterval(beat);
        beat = null;
        abort.abort();
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (event: string, data: unknown): void => {
                if (closed) return;
                try {
                    controller.enqueue(
                        encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
                    );
                } catch {
                    stop();
                }
            };
            const close = (): void => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            };

            request.signal.addEventListener("abort", close);
            beat = setInterval(() => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(":\n\n"));
                } catch {
                    stop();
                }
            }, BEAT_MS);

            void followRuntimeLogs({
                services,
                tail: parsed.data.tail,
                signal: abort.signal,
                onFollowing: (serviceId, containers) =>
                    send("following", { serviceId, containers }),
                onLines: (lines) => send("lines", lines),
                onEnded: (serviceId, container, reason) =>
                    send("ended", { serviceId, container, reason })
            })
                .catch(() => undefined)
                .finally(() => {
                    send("done", {});
                    close();
                });
        },
        cancel() {
            stop();
        }
    });

    return new Response(stream, {
        headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store, no-transform",
            connection: "keep-alive",
            // Tells nginx-style proxies not to buffer the stream.
            "x-accel-buffering": "no"
        }
    });
}
