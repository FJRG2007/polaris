/**
 * The live channel behind a wall panel handed out as a link.
 *
 * The devices screen's stream (`api/home/devices/live`) in the shape a tablet
 * on the wall needs: no session, the link's token is the right, and only the
 * devices on the panel are ever sent. What the panel reaches is read again
 * every half minute, so a card taken off, or the link taken back, stops
 * arriving; and the stream ends on its own after ten minutes so the browser
 * reconnects through the link's checks again.
 *
 * It never causes a read of the house's accounts: a screen nobody signed in
 * on is told about changes and asks nothing.
 *
 * Node runtime, never cached.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { homeInstall } from "../../../../../../lib/access";
import { panelReach } from "../../../../../../lib/panels";
import type { PlacesReach } from "../../../../../../lib/sharing";
import {
    frameFor,
    subscribeDeviceChanges,
    type InstallDeviceChange
} from "../../../../../../lib/device-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const REACH_TTL_MS = 30_000;
const LIFETIME_MS = 10 * 60_000;

/** The panel's devices as the reach the frames are filtered by. */
function asReach(devices: ReadonlySet<string>): PlacesReach {
    return {
        everything: false,
        cameras: new Map(),
        devices: new Map([...devices].map((id) => [id, "view"])),
        deviceActions: new Map(),
        upses: new Map()
    };
}

/** The panel a token opens now and the devices on it, or null for nothing. */
async function reachOf(
    token: string,
    installedAppId: string
): Promise<{ placeId: string; reach: PlacesReach } | null> {
    const reached = await host.accessGrants.linkReach(token);
    if (!reached || reached.subjectType !== "place.panel" || reached.standing !== "live") {
        return null;
    }
    const devices = await panelReach(installedAppId, reached.subjectId);
    const row = await prisma.placePanel.findFirst({
        where: { id: reached.subjectId, installedAppId },
        select: { placeId: true }
    });
    return row ? { placeId: row.placeId, reach: asReach(devices) } : null;
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });
    const first = await reachOf(String(token), install.id);
    if (!first) return new Response("Not found", { status: 404 });
    let reach = first.reach;
    const placeId = first.placeId;

    const encoder = new TextEncoder();
    let closed = false;
    let unsubscribe: (() => void) | null = null;
    const timers: ReturnType<typeof setInterval>[] = [];
    let end: ReturnType<typeof setTimeout> | null = null;
    let close: () => void = () => undefined;

    function stop(): void {
        if (closed) return;
        closed = true;
        for (const timer of timers) clearInterval(timer);
        if (end) clearTimeout(end);
        unsubscribe?.();
        unsubscribe = null;
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
            write("retry: 1000\n\n");
            write(`data: ${JSON.stringify({ kind: "ready" })}\n\n`);
            unsubscribe = subscribeDeviceChanges((change: InstallDeviceChange) => {
                if (closed || change.installedAppId !== install.id) return;
                const frame = frameFor(change, reach, placeId);
                if (frame) write(`data: ${JSON.stringify({ kind: "devices", ...frame })}\n\n`);
            });
            timers.push(setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS));
            timers.push(
                setInterval(() => {
                    void reachOf(String(token), install.id)
                        .then((next) => {
                            if (!next) return stop();
                            reach = next.reach;
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
