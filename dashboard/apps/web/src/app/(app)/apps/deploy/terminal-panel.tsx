"use client";

/**
 * Interactive terminal. Mints a one-shot ticket, opens a WebSocket to the deploy
 * sidecar presenting the token over Sec-WebSocket-Protocol, and wires xterm.js to
 * it through the shared terminal view (`terminal-view.tsx`): server output ->
 * terminal, keystrokes -> server, and a resize control frame on fit.
 *
 * The same panel serves a container on a deploy target, a container on a
 * Containers connection, and a shell on a registered server; which one is
 * decided server-side from the ticket, so the only difference here is what the
 * ticket is minted for.
 */

import { Button } from "@polaris/ui";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, RotateCw, Search, ShieldAlert } from "lucide-react";
import type { LocalPath } from "@/lib/server-local-path";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { TerminalView, type TerminalTransport } from "./terminal-view";

/** What to attach to: a container on a deploy target, a container on a
 *  Containers connection, a registered server - as the Polaris login, or as root
 *  where that server granted it - or the terminal a coding-agent session is
 *  running in. */
export type TerminalTarget =
    | { kind: "container"; applicationId: string }
    | { kind: "docker"; connectionId: string; containerRef: string }
    | { kind: "host"; hostId: string; asRoot?: boolean }
    /** `shell` names one more shell beside the agent (a tab); absent attaches
     *  to the agent itself. */
    | { kind: "agent"; sessionId: string; shell?: number };

/**
 * Why a session ended before it ever started. `unreachable` is the one that used
 * to read as a plain "disconnected": the socket closed without the far end ever
 * answering, which on a WebSocket almost always means the browser refused it
 * before it left - and the usual reason is a certificate it does not trust, which
 * it will not offer to click through the way it does for a page.
 */
type Failure = { kind: "unreachable" } | { kind: "refused"; reason: string };

/**
 * The reasons the terminal sidecar closes with (`ws-server.mjs`), and the
 * sentence each one is shown as. The sidecar accepts the socket BEFORE it
 * redeems the ticket or dials the server, so every one of these arrives on a
 * connection that has already opened - which is why they used to read as a
 * plain "disconnected" with nothing said and nothing to press.
 */
type CloseReason =
    | "expired"
    | "noTerminal"
    | "gone"
    | "unreachable"
    | "identity"
    | "login"
    | "shell"
    | "limit"
    | "ended"
    | "elsewhere";

export const CLOSE_REASONS: Record<string, CloseReason | undefined> = {
    "invalid ticket": "expired",
    "could not open terminal": "noTerminal",
    "server unavailable": "gone",
    "connection unavailable": "gone",
    "server unreachable": "unreachable",
    "server identity changed": "identity",
    "server refused the login": "login",
    "could not open a shell on the server": "shell",
    "session limit reached": "limit",
    "session ended": "ended",
    "session opened elsewhere": "elsewhere"
};

/** The control frame a server shell opens with, naming the long-lived session
 *  the socket is attached to. Anything else is terminal output. Pure. */
export function sessionFrame(data: unknown): { id: string; number: number } | null {
    if (typeof data !== "string" || !data.startsWith('{"session"')) return null;
    try {
        const parsed = JSON.parse(data) as { session?: { id?: unknown; number?: unknown } };
        const { id, number } = parsed.session ?? {};
        return typeof id === "string" && typeof number === "number" ? { id, number } : null;
    } catch {
        return null;
    }
}

/** Close codes the sidecar uses for a session it refused or ended (4001-4007). A close
 *  in this range is a refusal even after the socket opened. */
function isRefusal(code: number): boolean {
    return code >= 4000 && code < 5000;
}

/**
 * What a closed socket means for the panel. A session that ran and ended is just
 * over. A refusal - a 4xxx close, which the sidecar sends after the socket has
 * opened - says why, as does any close with a reason before it opened. A close
 * that never opened and says nothing never reached the sidecar at all, which is
 * almost always the certificate. Pure and unit-tested.
 */
export function closeOutcome(
    opened: boolean,
    code: number,
    rawReason: string
): { status: Status; failure: Failure | null } {
    const reason = rawReason.trim();
    if (opened && !(isRefusal(code) && reason)) {
        return { status: { kind: "disconnected" }, failure: null };
    }
    return {
        status:
            reason && !CLOSE_REASONS[reason]
                ? { kind: "reason", text: reason }
                : { kind: "couldNotConnect" },
        failure: reason ? { kind: "refused", reason } : { kind: "unreachable" }
    };
}

/** What looking for a server that stopped answering where it is recorded found:
 *  the address it moved to, or what the search saw instead. */
export type FindServerResult = { found?: string; error?: string; path?: LocalPath };

/** What the note says about the search, from what it returned. */
type Search =
    { kind: "idle" | "looking" | "notFound" | "cannotLook" } | { kind: "error"; text: string };

/** Sort a search result into retry (it moved and was adopted, or it answers
 *  where it is recorded again) or what to say. Pure and unit-tested. */
export function searchOutcome(result: FindServerResult | null): "retry" | Search {
    if (!result) return { kind: "notFound" };
    if (result.found) return "retry";
    if (result.error) return { kind: "error", text: result.error };
    switch (result.path?.kind) {
        case "unknown":
            return { kind: "cannotLook" };
        case "already":
        case "none":
        case "found":
            return "retry";
        default:
            return { kind: "notFound" };
    }
}

/** What the corner of the panel says: one of its own states, or the reason the
 *  far end gave, which is shown as it came. */
type Status =
    | {
          kind:
              | "connecting"
              | "connected"
              | "disconnected"
              | "couldNotConnect"
              | "couldNotAuthorize"
              | "looking";
      }
    | { kind: "connectingTo"; address: string }
    | { kind: "reason"; text: string };

/** The ticket request for a target: which session the sidecar opens for it. */
function ticketBody(target: TerminalTarget, resume: string | undefined): Record<string, unknown> {
    switch (target.kind) {
        case "host":
            return { hostId: target.hostId, mode: target.asRoot ? "ssh-root" : "ssh", terminalSessionId: resume };
        case "docker":
            return { connectionId: target.connectionId, containerRef: target.containerRef };
        case "agent":
            return { sessionId: target.sessionId, ...(target.shell === undefined ? {} : { shell: true }) };
        default:
            return { applicationId: target.applicationId, mode: "terminal" };
    }
}

/** What identifies a target's connection: its contents, not the object. Pure. */
export function targetKey(target: TerminalTarget): string {
    switch (target.kind) {
        case "host":
            return `host:${target.hostId}:${target.asRoot ? "root" : "login"}`;
        case "docker":
            return `docker:${target.connectionId}:${target.containerRef}`;
        case "agent":
            return `agent:${target.sessionId}:${target.shell ?? "agent"}`;
        default:
            return `app:${target.applicationId}`;
    }
}

export function TerminalPanel({
    target,
    label,
    findServer,
    resumeId,
    onSession,
    onClosed,
    onMoved,
    polarPlace,
    toolbar,
    fill = false,
    menuContainer,
    height = "h-80"
}: {
    target: TerminalTarget;
    label: string;
    /** For a server shell: the long-lived session to return to. Absent opens a
     *  new one, whose id arrives through `onSession`. */
    resumeId?: string;
    onSession?: (id: string, number: number) => void;
    /** The socket closed, for whatever reason. */
    onClosed?: () => void;
    /** The server was found at another address, and the terminal is opening
     *  there. */
    onMoved?: (address: string) => void;
    /** Where this terminal is, as Polar is told when asked about it. Defaults
     *  to the label. */
    polarPlace?: string;
    /** More buttons for the header, after the panel's own. */
    toolbar?: ReactNode;
    /** Fill the parent's height instead of the fixed `height`. */
    fill?: boolean;
    /** Where the right-click menu is portalled: the element shown full screen,
     *  when there is one, or nothing would be seen of it. */
    menuContainer?: HTMLElement | null;
    height?: string;
    /** For a server shell: look for the server on the network after nothing
     *  answered at its recorded address, and move it there when found. */
    findServer?: () => Promise<FindServerResult>;
}) {
    const t = useTranslations("common");
    const [status, setStatus] = useState<Status>({ kind: "connecting" });
    const [failure, setFailure] = useState<Failure | null>(null);
    // Bumped by Retry: the session is keyed on it, so asking again is a fresh
    // ticket and a fresh socket rather than a reconnect of the dead one.
    const [attempt, setAttempt] = useState(0);
    // The address the server was just found at, said while connecting there.
    const movedTo = useRef<string | null>(null);
    // The server is looked for on its own once per panel, not once per failure:
    // found and still refusing would otherwise go round for as long as it is open.
    const lookedForServer = useRef(false);
    // A Retry returns to the session this panel was on, not a fresh one.
    const sessionRef = useRef(resumeId);
    const callbacks = useRef({ onSession, onClosed });
    callbacks.current = { onSession, onClosed };

    // Mint a ticket, then open the WS with the token as the subprotocol. The
    // view calls this once per terminal it puts on screen.
    const transport: TerminalTransport = (sink) => {
        let disposed = false;
        let socket: WebSocket | undefined;
        let opened = false;
        const undo: (() => void)[] = [];
        setFailure(null);
        setStatus(movedTo.current ? { kind: "connectingTo", address: movedTo.current } : { kind: "connecting" });

        void (async () => {
            const res = await fetch("/api/deploy/terminal/ticket", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(ticketBody(target, sessionRef.current))
            }).catch(() => null);
            if (disposed) return;
            if (!res?.ok) {
                // The route says why (no such connection, no pinned key, not
                // permitted), and that is more use than "could not authorize".
                const reason = (await res?.json().catch(() => null)) as { error?: string } | null;
                if (disposed) return;
                setStatus(reason?.error ? { kind: "reason", text: reason.error } : { kind: "couldNotAuthorize" });
                return;
            }
            const { token } = (await res.json()) as { token: string };
            if (disposed) return;
            const scheme = window.location.protocol === "https:" ? "wss" : "ws";
            const ws = new WebSocket(`${scheme}://${window.location.host}/api/deploy/ws`, token);
            socket = ws;
            ws.binaryType = "arraybuffer";

            const sendSize = (): void => {
                if (ws.readyState !== WebSocket.OPEN) return;
                const { cols, rows } = sink.size();
                ws.send(JSON.stringify({ resize: { cols, rows } }));
            };

            ws.onopen = () => {
                opened = true;
                movedTo.current = null;
                setStatus({ kind: "connected" });
                sink.refit();
                sendSize();
            };
            ws.onmessage = (event) => {
                const frame = target.kind === "host" ? sessionFrame(event.data) : null;
                if (frame) {
                    sessionRef.current = frame.id;
                    callbacks.current.onSession?.(frame.id, frame.number);
                    return;
                }
                sink.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : (event.data as string));
            };
            // A session that ran and ended is just over. One that never opened is a
            // failure, and which of the two it is decides what there is to say: the
            // far end closing with a reason (no ticket, no shell) is that reason,
            // while a close with nothing to say never got there at all.
            ws.onclose = (event) => {
                if (disposed) return;
                const outcome = closeOutcome(opened, event.code, event.reason);
                setStatus(outcome.status);
                setFailure(outcome.failure);
                callbacks.current.onClosed?.();
            };
            // Fires before the close on a connection that never opened; the close
            // handler has the code and reason, so this only avoids a silent gap.
            ws.onerror = () => !opened && !disposed && setStatus({ kind: "couldNotConnect" });

            sink.input((data) => {
                if (ws.readyState === WebSocket.OPEN) ws.send(data);
            });
            undo.push(() => sink.input(null));
            // Every size change is told to the shell.
            undo.push(sink.onResize(sendSize));
        })();

        return () => {
            disposed = true;
            socket?.close();
            for (const step of undo.reverse()) step();
        };
    };

    useEffect(() => {
        if (resumeId === undefined || resumeId === sessionRef.current) return;
        sessionRef.current = resumeId;
        setAttempt((n) => n + 1);
    }, [resumeId]);

    const statusText =
        status.kind === "reason"
            ? status.text
            : status.kind === "connectingTo"
              ? t("terminal.status.connectingTo", { address: status.address })
              : t(`terminal.status.${status.kind}`);
    const place = polarPlace ?? label;

    return (
        <TerminalView
            transport={transport}
            transportKey={`${targetKey(target)}#${attempt}`}
            label={label}
            status={statusText}
            polarPlace={place}
            // A server's shell binds the chat to that server and account, so
            // a command Polar proposes goes there unless it names another.
            polarServer={target.kind === "host" ? { id: target.hostId, root: target.asRoot === true, name: place } : null}
            toolbar={toolbar}
            fill={fill}
            menuContainer={menuContainer}
            height={height}
        >
            {failure ? (
                <FailureNote
                    failure={failure}
                    label={label}
                    findServer={findServer}
                    looked={lookedForServer}
                    onSearching={(searching) =>
                        setStatus((current) =>
                            searching
                                ? { kind: "looking" }
                                : current.kind === "looking"
                                  ? { kind: "couldNotConnect" }
                                  : current
                        )
                    }
                    onRetry={(found) => {
                        if (found) {
                            movedTo.current = found;
                            onMoved?.(found);
                        }
                        setAttempt((n) => n + 1);
                    }}
                />
            ) : null}
        </TerminalView>
    );
}
/**
 * What to do about a session that never opened. A terminal that reaches the server
 * and is turned away says why and is worth another try; one the browser never let
 * out says nothing at all, and the answer is almost never "try again" - it is the
 * certificate for this address, which a WebSocket refuses silently where a page
 * would at least offer to continue.
 *
 * A server that did not answer at its recorded address is looked for once on the
 * network, without being asked: it is the one failure here Polaris can repair
 * itself, and almost always a DHCP lease that moved. Found, the terminal opens
 * again at the new address.
 */
function FailureNote({
    failure,
    label,
    findServer,
    looked,
    onSearching,
    onRetry
}: {
    failure: Failure;
    /** Who and where the terminal is, as the header shows it. */
    label: string;
    findServer?: () => Promise<FindServerResult>;
    looked: { current: boolean };
    /** The search for the server started or stopped. */
    onSearching: (searching: boolean) => void;
    /** Try again; `found` is the address the server was found at. */
    onRetry: (found?: string) => void;
}) {
    const t = useTranslations("common");
    const known = failure.kind === "refused" ? CLOSE_REASONS[failure.reason] : undefined;
    const canFind = known === "unreachable" && Boolean(findServer);
    const [search, setSearch] = useState<Search>({ kind: "idle" });
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const look = async (): Promise<void> => {
        if (!findServer) return;
        setSearch({ kind: "looking" });
        onSearching(true);
        const result = await findServer().catch(() => null);
        const outcome = searchOutcome(result);
        if (!mounted.current) return;
        onSearching(false);
        if (outcome === "retry") onRetry(result?.found);
        else setSearch(outcome);
    };

    useEffect(() => {
        if (!canFind || looked.current) return;
        looked.current = true;
        void look();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failure
    }, [canFind]);

    // A server that moved is the common case and Polaris is already on it: said
    // as what is happening, not as a warning that goes away a second later.
    if (canFind && search.kind === "looking") {
        return (
            <p
                role="status"
                className="flex min-w-0 items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
            >
                <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin" aria-hidden />
                <span className="min-w-0">{t("terminal.searching", { label })}</span>
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-2 rounded-md border border-warning-edge bg-warning-soft px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {failure.kind === "refused" ? (
                    <span className="min-w-0">
                        {known
                            ? t(`terminal.reasons.${known}`)
                            : t("terminal.refused", { reason: failure.reason })}
                        {search.kind === "looking" ? ` ${t("terminal.looking")}` : null}
                        {search.kind === "notFound" ? ` ${t("terminal.notFound")}` : null}
                        {search.kind === "cannotLook" ? ` ${t("terminal.cannotLook")}` : null}
                        {search.kind === "error" ? ` ${search.text}` : null}
                    </span>
                ) : (
                    <span>
                        {t.rich("terminal.untrusted", {
                            download: (chunks) => (
                                <a
                                    key="download"
                                    href="/api/system/local-ca"
                                    className="font-medium text-foreground underline underline-offset-2"
                                >
                                    {chunks}
                                </a>
                            )
                        })}
                    </span>
                )}
            </p>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => onRetry()}>
                    <RotateCw className="size-3.5" /> {t("terminal.retry")}
                </Button>
                {canFind ? (
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={search.kind === "looking"}
                        onClick={() => void look()}
                    >
                        <Search className="size-3.5" /> {t("terminal.lookForIt")}
                    </Button>
                ) : null}
            </div>
        </div>
    );
}
