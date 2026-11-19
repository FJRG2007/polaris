/**
 * What the Polaris phone app shows as a notification, as it happens.
 *
 * A phone has no tab open: the page that raises a toast for a new message is
 * not running while the app is in the background, and an Android WebView has
 * no Web Push. So the app keeps this one connection open from a service of its
 * own, and draws each frame as a system notification.
 *
 * Nothing is decided here that the toast does not decide: every arrival goes
 * through `messageToasts`, the same read with the same access check, mutes,
 * notification levels, read marks and chat lock - so the phone and the corner
 * of a browser cannot disagree about what is news. A frame says only what the
 * notification draws; opening it opens the conversation, read through its own
 * check.
 */

import { messageToasts } from "@/lib/chat/toasts";
import { readerWords } from "@/lib/i18n/reader-words";
import { subscribeChatChanges } from "@/lib/chat/live";
import { holdStreamScope } from "@/lib/chat/stream-scope";
import { backgroundUser, sessionCan } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Keeps a phone's connection, and every proxy on the way, from deciding it is idle. */
const HEARTBEAT_MS = 25_000;
/** Messages in one conversation inside this window are one look-up. */
const COALESCE_MS = 400;
/** How old the answer to "which conversations is this person in" may be when a
 *  frame arrives for one outside it: being added to a conversation is that case. */
const SCOPE_TTL_MS = 10_000;

export interface MobileNotice {
    readonly kind: "message" | "call" | "call-ended";
    readonly channelId: string;
    /** One per conversation: a newer message replaces the notification. */
    readonly tag: string;
    readonly title: string;
    readonly body: string;
    /** Where opening it lands, on this instance. */
    readonly path: string;
}

export async function GET(): Promise<Response> {
    const session = await backgroundUser();
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (!(await sessionCan(session, "chat.use"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    const actor = { id: session.id };
    // Resolved while the request is still the request: the callbacks below run
    // long after it, where the reader's language is no longer known.
    const [t, chat] = await Promise.all([readerWords("components"), readerWords("chat")]);
    const encoder = new TextEncoder();
    const scope = holdStreamScope(actor);
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let closed = false;

    function stop(): void {
        if (closed) return;
        closed = true;
        scope.release();
        if (heartbeat) clearInterval(heartbeat);
        for (const timer of waiting.values()) clearTimeout(timer);
        waiting.clear();
        unsubscribe?.();
        unsubscribe = null;
    }

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            function write(frame: string): void {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(frame));
                } catch {
                    stop();
                }
            }
            const send = (notice: MobileNotice) => write(`data: ${JSON.stringify(notice)}\n\n`);

            async function announce(channelId: string): Promise<void> {
                const toasts = await messageToasts(actor, [channelId]).catch((error: unknown) => {
                    console.error("mobile: could not read a message to announce:", error);
                    return [];
                });
                for (const toast of toasts) {
                    const title = toast.locked
                        ? t("messageToasts.locked")
                        : toast.inChannel
                          ? t("messageToasts.inChannel", {
                                author: toast.authorName,
                                channel: toast.conversation
                            })
                          : toast.authorName;
                    send({
                        kind: "message",
                        channelId: toast.channelId,
                        tag: `chat:${toast.channelId}`,
                        title,
                        body: toast.locked ? "" : toast.excerpt,
                        path: `/chat/c/${toast.channelId}`
                    });
                }
            }

            function arrived(channelId: string): void {
                if (waiting.has(channelId)) return;
                waiting.set(
                    channelId,
                    setTimeout(() => {
                        waiting.delete(channelId);
                        if (!closed) void announce(channelId);
                    }, COALESCE_MS)
                );
            }

            await scope.refresh();
            if (closed) return;

            unsubscribe = subscribeChatChanges((change) => {
                if (closed || !change.channelId || change.actorId === actor.id) return;
                const channelId = change.channelId;
                const handle = () => {
                    if (!scope.reachable().has(channelId)) return;
                    // A new message, not one that changed in place: an edit or a
                    // reaction is not news, here any more than in the corner toast.
                    if (change.kind === "posted" && !change.messageIds?.length) arrived(channelId);
                    if (change.kind === "call" && change.call && !change.call.voice) {
                        const ringing = change.call.state === "ringing";
                        // A ring names who hears it, and leaves out whoever blocked
                        // the caller: the phone rings for exactly the same people.
                        if (ringing && change.audience && !change.audience.includes(actor.id)) return;
                        send({
                            kind: ringing ? "call" : "call-ended",
                            channelId,
                            tag: `call:${channelId}`,
                            title: ringing
                                ? change.actorName
                                    ? t("calls.calling", { name: change.actorName })
                                    : chat("callStage.incomingCall")
                                : "",
                            body: "",
                            path: `/chat/c/${channelId}`
                        });
                    }
                };
                if (scope.reachable().has(channelId) || Date.now() - scope.resolvedAt() < SCOPE_TTL_MS) {
                    handle();
                    return;
                }
                void scope.refresh().then(() => {
                    if (!closed) handle();
                });
            });

            heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
            write(": connected\n\n");
        },
        cancel() {
            stop();
        }
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        }
    });
}
