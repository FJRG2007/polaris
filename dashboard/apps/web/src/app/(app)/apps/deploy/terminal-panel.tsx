"use client";

/**
 * Interactive terminal. Mints a one-shot ticket, opens a WebSocket to the deploy
 * sidecar presenting the token over Sec-WebSocket-Protocol, and wires xterm.js to
 * it: server output -> terminal, keystrokes -> server, and a resize control frame
 * on fit. xterm is imported dynamically so it stays out of the server bundle.
 *
 * The same panel serves a container on a deploy target, a container on a
 * Containers connection, and a shell on a registered server; which one is
 * decided server-side from the ticket, so the only difference here is what the
 * ticket is minted for.
 */

import "@xterm/xterm/css/xterm.css";
import { Button } from "@polaris/ui";
import { useEffect, useRef, useState } from "react";
import { RotateCw, Search, ShieldAlert } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { LocalPath } from "@/lib/server-local-path";

/** What to attach to: a container on a deploy target, a container on a
 *  Containers connection, a registered server - as the Polaris login, or as root
 *  where that server granted it - or the terminal a coding-agent session is
 *  running in. */
export type TerminalTarget =
    | { kind: "container"; applicationId: string }
    | { kind: "docker"; connectionId: string; containerRef: string }
    | { kind: "host"; hostId: string; asRoot?: boolean }
    | { kind: "agent"; sessionId: string };

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
    "expired" | "noTerminal" | "gone" | "unreachable" | "identity" | "login" | "shell";

export const CLOSE_REASONS: Record<string, CloseReason | undefined> = {
    "invalid ticket": "expired",
    "could not open terminal": "noTerminal",
    "server unavailable": "gone",
    "connection unavailable": "gone",
    "server unreachable": "unreachable",
    "server identity changed": "identity",
    "server refused the login": "login",
    "could not open a shell on the server": "shell"
};

/** Close codes the sidecar uses for a session it refused (4001-4004). A close
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
              "connecting" | "connected" | "disconnected" | "couldNotConnect" | "couldNotAuthorize";
      }
    | { kind: "reason"; text: string };

export function TerminalPanel({
    target,
    label,
    findServer
}: {
    target: TerminalTarget;
    label: string;
    /** For a server shell: look for the server on the network after nothing
     *  answered at its recorded address, and move it there when found. */
    findServer?: () => Promise<FindServerResult>;
}) {
    const t = useTranslations("common");
    const mountRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState<Status>({ kind: "connecting" });
    const [failure, setFailure] = useState<Failure | null>(null);
    // Bumped by Retry: the session is keyed on it, so asking again is a fresh
    // ticket and a fresh socket rather than a reconnect of the dead one.
    const [attempt, setAttempt] = useState(0);
    // The server is looked for on its own once per panel, not once per failure:
    // found and still refusing would otherwise go round for as long as it is open.
    const lookedForServer = useRef(false);
    // The object identity of `target` would restart the session on every parent
    // render; its contents are what actually decide the connection.
    const key =
        target.kind === "host"
            ? `host:${target.hostId}:${target.asRoot ? "root" : "login"}`
            : target.kind === "docker"
              ? `docker:${target.connectionId}:${target.containerRef}`
              : target.kind === "agent"
                ? `agent:${target.sessionId}`
                : `app:${target.applicationId}`;

    useEffect(() => {
        let disposed = false;
        let socket: WebSocket | undefined;
        let cleanup: (() => void) | undefined;
        let opened = false;
        setFailure(null);
        setStatus({ kind: "connecting" });

        async function start(): Promise<void> {
            const [{ Terminal }, { FitAddon }] = await Promise.all([
                import("@xterm/xterm"),
                import("@xterm/addon-fit")
            ]);
            if (disposed || !mountRef.current) return;

            const term = new Terminal({
                fontSize: 13,
                cursorBlink: true,
                theme: { background: "#0b0e14" }
            });
            const fit = new FitAddon();
            term.loadAddon(fit);
            term.open(mountRef.current);
            fit.fit();

            // Mint a ticket, then open the WS with the token as the subprotocol.
            const res = await fetch("/api/deploy/terminal/ticket", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(
                    target.kind === "host"
                        ? { hostId: target.hostId, mode: target.asRoot ? "ssh-root" : "ssh" }
                        : target.kind === "docker"
                          ? { connectionId: target.connectionId, containerRef: target.containerRef }
                          : target.kind === "agent"
                            ? { sessionId: target.sessionId }
                            : { applicationId: target.applicationId, mode: "terminal" }
                )
            });
            if (!res.ok) {
                // The route says why (no such connection, no pinned key, not
                // permitted), and that is more use than "could not authorize".
                const reason = (await res.json().catch(() => null)) as { error?: string } | null;
                setStatus(
                    reason?.error
                        ? { kind: "reason", text: reason.error }
                        : { kind: "couldNotAuthorize" }
                );
                return;
            }
            const { token } = (await res.json()) as { token: string };
            const scheme = window.location.protocol === "https:" ? "wss" : "ws";
            socket = new WebSocket(`${scheme}://${window.location.host}/api/deploy/ws`, token);
            socket.binaryType = "arraybuffer";

            const sendResize = (): void => {
                fit.fit();
                socket?.readyState === WebSocket.OPEN &&
                    socket.send(JSON.stringify({ resize: { cols: term.cols, rows: term.rows } }));
            };

            socket.onopen = () => {
                opened = true;
                setStatus({ kind: "connected" });
                sendResize();
            };
            socket.onmessage = (event) => {
                term.write(
                    event.data instanceof ArrayBuffer
                        ? new Uint8Array(event.data)
                        : (event.data as string)
                );
            };
            // A session that ran and ended is just over. One that never opened is a
            // failure, and which of the two it is decides what there is to say: the
            // far end closing with a reason (no ticket, no shell) is that reason,
            // while a close with nothing to say never got there at all.
            socket.onclose = (event) => {
                const outcome = closeOutcome(opened, event.code, event.reason);
                setStatus(outcome.status);
                setFailure(outcome.failure);
            };
            // Fires before the close on a connection that never opened; the close
            // handler has the code and reason, so this only avoids a silent gap.
            socket.onerror = () => !opened && setStatus({ kind: "couldNotConnect" });

            const onData = term.onData((input) => {
                if (socket?.readyState === WebSocket.OPEN) socket.send(input);
            });
            const onResize = (): void => sendResize();
            window.addEventListener("resize", onResize);

            cleanup = () => {
                onData.dispose();
                window.removeEventListener("resize", onResize);
                term.dispose();
            };
        }

        void start();
        return () => {
            disposed = true;
            socket?.close();
            cleanup?.();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands in
        // for the target's contents; depending on the object would reconnect on
        // every parent render.
    }, [key, attempt]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <span>
                    {status.kind === "reason" ? status.text : t(`terminal.status.${status.kind}`)}
                </span>
            </div>
            <div
                ref={mountRef}
                className="h-80 w-full overflow-hidden rounded-md bg-[#0b0e14] p-2"
            />
            {failure ? (
                <FailureNote
                    failure={failure}
                    findServer={findServer}
                    looked={lookedForServer}
                    onRetry={() => setAttempt((n) => n + 1)}
                />
            ) : null}
        </div>
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
    findServer,
    looked,
    onRetry
}: {
    failure: Failure;
    findServer?: () => Promise<FindServerResult>;
    looked: { current: boolean };
    onRetry: () => void;
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
        const outcome = searchOutcome(await findServer().catch(() => null));
        if (!mounted.current) return;
        if (outcome === "retry") onRetry();
        else setSearch(outcome);
    };

    useEffect(() => {
        if (!canFind || looked.current) return;
        looked.current = true;
        void look();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failure
    }, [canFind]);

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
                <Button size="sm" variant="secondary" onClick={onRetry}>
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
