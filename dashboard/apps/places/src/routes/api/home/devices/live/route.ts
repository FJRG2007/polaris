/**
 * The live channel behind the devices screen.
 *
 * A tab holds this open and is sent each device the moment a read or a press
 * finds it changed, so a door opened by the keypad downstairs appears without
 * anybody pressing "Check again". It is Home Assistant's `subscribe_entities`
 * in Polaris' own transport - the server-sent events Chat already uses - and
 * like it, a frame names only what changed.
 *
 * Two filters before anything is written, and both are the ones the list
 * itself applies: the place the reader is looking at (plus what is not placed
 * anywhere yet), and what they reach - everything for somebody who lives here,
 * the doors they were lent for a visitor. A device that leaves either is sent
 * as removed, by id and nothing else. Accounts go only to somebody who may see
 * them, as on the screen.
 *
 * Holding this open is also what keeps the devices read (`device-watch`), but
 * only for somebody who could have pressed the button that reads them: a
 * visitor's screen is told about changes and never causes a call to the
 * house's accounts.
 *
 * What the reader reaches is resolved again every half minute, so a lent door
 * taken back stops arriving; and the stream ends on its own after a few
 * minutes, so the browser reconnects through the sign-in check again.
 *
 * Node runtime, never cached.
 */

import { host } from "@polaris/app-host";
import { homeInstall } from "../../../../../lib/access";
import { watchDevices } from "../../../../../lib/device-watch";
import { currentPlace } from "../../../../../lib/current-place";
import { placesReach, type PlacesReach } from "../../../../../lib/sharing";
import {
    frameFor,
    subscribeDeviceChanges,
    type InstallDeviceChange
} from "../../../../../lib/device-live";

const { apiUser } = host.apiSession;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Idle keep-alive: proxies drop a stream that says nothing for long enough. */
const HEARTBEAT_MS = 25_000;
/** How long what the reader reaches is trusted. */
const REACH_TTL_MS = 30_000;
/** How long one stream lives before the browser is made to open another. */
const LIFETIME_MS = 10 * 60_000;

/** Whether the reader reaches nothing of Places at all. */
function reachesNothing(reach: PlacesReach): boolean {
    return !reach.everything && reach.cameras.size === 0 && reach.devices.size === 0;
}

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });
    let reach = await placesReach(user);
    if (reachesNothing(reach)) return new Response("Forbidden", { status: 403 });
    const { current } = await currentPlace(install.id);

    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let release: (() => void) | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];
    let end: ReturnType<typeof setTimeout> | null = null;
    let close: () => void = () => undefined;

    function stop(): void {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        if (end) clearTimeout(end);
        unsubscribe?.();
        release?.();
        unsubscribe = null;
        release = null;
        close();
    }

    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            close = () => {
                try {
                    controller.close();
                } catch {
                    // Already closed by the other side.
                }
            };
            function write(frame: string): void {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(frame));
                } catch {
                    stop();
                }
            }

            // Reconnect quickly when this ends on purpose; the browser's own
            // default is a few seconds of a screen not being told anything.
            write("retry: 1000\n\n");
            write(`data: ${JSON.stringify({ kind: "ready" })}\n\n`);

            unsubscribe = subscribeDeviceChanges((change: InstallDeviceChange) => {
                if (closed || change.installedAppId !== install.id) return;
                const frame = frameFor(change, reach, current.id);
                if (frame) write(`data: ${JSON.stringify({ kind: "devices", ...frame })}\n\n`);
            });
            if (reach.everything) release = watchDevices(install.id);

            timers.push(setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS));
            timers.push(
                setInterval(() => {
                    void placesReach(user)
                        .then((next) => {
                            if (reachesNothing(next)) return stop();
                            reach = next;
                            // Somebody who stopped living here stops causing reads.
                            if (!next.everything && release) {
                                release();
                                release = null;
                            }
                        })
                        .catch(() => stop());
                }, REACH_TTL_MS)
            );
            end = setTimeout(stop, LIFETIME_MS);
        },
        cancel() {
            stop();
        }
    });

    request.signal.addEventListener("abort", stop);

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        }
    });
}
