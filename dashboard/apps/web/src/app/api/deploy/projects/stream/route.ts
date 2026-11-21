/**
 * The word that a service in this project changed state - a deploy started or
 * finished, a restart or a redeploy pressed on a Stream Deck or asked of the
 * assistant, a stop from another tab - pushed the moment it happens, so an open
 * project page redraws its service cards without waiting for its next poll.
 *
 * A frame carries a sequence number and nothing else: the page answers it by
 * reading itself again through the same session and checks. The reader's
 * access to the project is checked before the stream opens.
 */

import { z } from "zod";
import { onDeployChanged } from "@/lib/deploy/live";
import { backgroundUser, userHasManage } from "@/lib/session";
import { accessCan, projectAccess } from "@/lib/deploy-project-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a burst is gathered before the page is woken: a deploy's queued,
 *  building and running are often one moment to the person watching. */
const COALESCE_MS = 250;

/** Idle keep-alive. Proxies drop a stream that says nothing for long enough, and
 *  a comment frame is not delivered to the client as a message. */
const HEARTBEAT_MS = 25_000;

const query = z.object({ projectId: z.string().trim().uuid() });

export async function GET(request: Request): Promise<Response> {
    // A non-200 makes EventSource give up rather than reconnect every few
    // seconds against a session or a project that is gone.
    // i18n-ignore: status bodies no screen shows; the page keeps polling
    const refuse = (status: number) => Response.json({ error: "Unavailable" }, { status });
    const user = await backgroundUser();
    if (!user) return refuse(401);
    const parsed = query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) return refuse(400);
    const projectId = parsed.data.projectId;
    if (!(await userHasManage(user, "deploy.read"))) return refuse(404);
    const access = await projectAccess(projectId, user.id);
    if (!access || !accessCan(access, "project.read")) return refuse(404);

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let sequence = 0;

    function stop(): void {
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat) clearInterval(heartbeat);
        if (pending) clearTimeout(pending);
        heartbeat = null;
        pending = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const send = (chunk: string): void => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    stop();
                }
            };
            request.signal.addEventListener("abort", () => {
                stop();
                try {
                    controller.close();
                } catch {
                    // The client already went away.
                }
            });
            unsubscribe = onDeployChanged((changed) => {
                if ((changed !== null && changed !== projectId) || pending || closed) return;
                pending = setTimeout(() => {
                    pending = null;
                    sequence += 1;
                    send(`data: ${sequence}\n\n`);
                }, COALESCE_MS);
            });
            // How soon a dropped stream is tried again. The page reads once on
            // every reconnect, for whatever it missed while it was away.
            send("retry: 5000\n\n");
            heartbeat = setInterval(() => send(":\n\n"), HEARTBEAT_MS);
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
            "x-accel-buffering": "no"
        }
    });
}
