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
import { pendingApprovals, subscribeSignInApprovals } from "@/lib/mobile/sign-in-approval";

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
    readonly kind: "message" | "call" | "call-ended" | "sign-in" | "sign-in-ended";
    readonly channelId: string;
    /** One per conversation: a newer message replaces the notification. */
    readonly tag: string;
    readonly title: string;
    readonly body: string;
    /** Where opening it lands, on this instance. */
    readonly path: string;
    /** A sign-in asking this phone: the request to answer, and when it stops counting (epoch ms). */
    readonly approvalId?: string;
    readonly expiresAt?: number;
    /** A ringing call: the call to decline from the phone, and who is calling,
     *  which the phone's incoming-call screen names on its own. */
    readonly meetingId?: string;
    readonly caller?: string;
}

export async function GET(request: Request): Promise<Response> {
    const session = await backgroundUser();
    if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });
    // Sign-in approvals reach every account; messages and calls only one that may chat.
    const chatAllowed = await sessionCan(session, "chat.use");
    const actor = { id: session.id };
    // Resolved while the request is still the request: the callbacks below run
    // long after it, where the reader's language is no longer known.
    const [t, chat, api] = await Promise.all([readerWords("components"), readerWords("chat"), readerWords("api")]);
    const encoder = new TextEncoder();
    const scope = holdStreamScope(actor);
    const waiting = new Map<string, ReturnType<typeof setTimeout>>();
    /** The conversation each call rang in on this connection, so a decline on
     *  another device (which names only the call) stops this phone ringing. */
    const rang = new Map<string, string>();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let unsubscribe: (() => void) | null = null;
    let unsubscribeApprovals: (() => void) | null = null;
    let closed = false;
    // Which phone, by its app version and an account prefix, never more: enough to
    // tell from the logs whether a phone that missed a message was listening.
    const version = request.headers.get("user-agent")?.match(/PolarisMobile\/[\d.]+/)?.[0] ?? "unknown app";
    const who = `${session.id.slice(0, 8)} ${version}`;
    const openedAt = Date.now();

    function stop(): void {
        if (closed) return;
        closed = true;
        console.info(`mobile notices: ${who} disconnected after ${Math.round((Date.now() - openedAt) / 1000)}s`);
        scope.release();
        if (heartbeat) clearInterval(heartbeat);
        for (const timer of waiting.values()) clearTimeout(timer);
        waiting.clear();
        unsubscribe?.();
        unsubscribe = null;
        unsubscribeApprovals?.();
        unsubscribeApprovals = null;
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

            function ask(approval: { id: string; device: string | null; ip: string | null; expiresAt: Date }): void {
                send({
                    kind: "sign-in",
                    channelId: "",
                    tag: `sign-in:${approval.id}`,
                    title: api("mobile.signIn.askTitle"),
                    body:
                        approval.device && approval.ip
                            ? api("mobile.signIn.askBody", { device: approval.device, ip: approval.ip })
                            : (approval.device ?? api("mobile.signIn.askBodyUnknown")),
                    path: "/account/sessions",
                    approvalId: approval.id,
                    expiresAt: approval.expiresAt.getTime()
                });
            }

            if (chatAllowed) await scope.refresh();
            if (closed) return;

            if (chatAllowed) unsubscribe = subscribeChatChanges((change) => {
                if (closed) return;
                // Declined on another of this person's devices: their own act, so
                // it is read before the rule that skips one's own changes.
                if (change.kind === "call-settled") {
                    const channelId = change.meetingId ? rang.get(change.meetingId) : undefined;
                    if (!channelId || !change.audience?.includes(actor.id)) return;
                    rang.delete(change.meetingId!);
                    send({ kind: "call-ended", channelId, tag: `call:${channelId}`, title: "", body: "", path: `/chat/c/${channelId}` });
                    return;
                }
                if (!change.channelId || change.actorId === actor.id) return;
                // An ephemeral answer is never a phone notice, not even for its
                // audience: it is seen where it was asked for.
                if (change.kind === "posted" && change.audience) return;
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
                        const meetingId = change.call.meetingId;
                        if (ringing) rang.set(meetingId, channelId);
                        else rang.delete(meetingId);
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
                            path: `/chat/c/${channelId}`,
                            ...(ringing ? { meetingId, caller: change.actorName ?? chat("callStage.incomingCall") } : {})
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

            unsubscribeApprovals = subscribeSignInApprovals((change) => {
                if (closed || change.userId !== actor.id) return;
                if (change.kind === "requested") ask(change);
                else send({ kind: "sign-in-ended", channelId: "", tag: `sign-in:${change.id}`, title: "", body: "", path: "/" });
            });
            for (const approval of await pendingApprovals(actor.id).catch(() => [])) ask(approval);

            heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
            write(": connected\n\n");
            console.info(`mobile notices: ${who} connected`);
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
