"use client";

/**
 * Redraws the page when what this account may reach changes.
 *
 * The app switcher, the rail and every screen behind them are resolved on the
 * server from the permissions the reader holds. So an administrator granting
 * somebody the Mail app, or taking Deploy back off them, changed nothing the
 * person was looking at: the switcher went on offering what it offered when the
 * page was rendered, and the only way out was a reload nobody thinks to do -
 * least of all the person who has not been told anything happened.
 *
 * A frame here says only that something moved. The answer is `router.refresh()`,
 * which re-renders the frame and the screen inside it on the server, with the
 * session and the checks it always had - so the switcher gains the app, or loses
 * it, and somebody standing on a screen they no longer hold is sent where they
 * do belong by the page's own guard rather than by anything decided here.
 *
 * It rides the stream through the shared channel, so a browser with six Polaris
 * tabs open costs one connection between them rather than six.
 */

import { useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { subscribeSharedStream } from "@/lib/shared-stream";
import { useSessionScope } from "@/components/session-scope";

const STREAM_PATH = "/api/access/stream";

/**
 * How long a burst is gathered before the page is redrawn.
 *
 * Moving somebody between roles is several writes, and a refresh is the whole
 * screen: doing it four times in a second would be four renders of a page that
 * only ends up one way.
 */
const SETTLE_MS = 400;

export function AccessWatcher() {
    const router = useRouter();
    const scope = useSessionScope();
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const settle = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            timer.current = null;
            router.refresh();
        }, SETTLE_MS);
    }, [router]);

    useEffect(() => {
        const stop = subscribeSharedStream(STREAM_PATH, scope, ({ data }) => {
            let kind: unknown;
            try {
                kind = (JSON.parse(data) as { kind?: unknown }).kind;
            } catch {
                return;
            }
            // A tab left open across a deploy is talking to a server that has
            // moved on, and a frame it does not understand is ignored rather
            // than turned into a redraw loop.
            if (kind !== "access") return;
            settle();
        });
        return () => {
            if (timer.current) clearTimeout(timer.current);
            timer.current = null;
            stop();
        };
    }, [scope, settle]);

    return null;
}
