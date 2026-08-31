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
import { RotateCw, ShieldAlert } from "lucide-react";

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

export function TerminalPanel({ target, label }: { target: TerminalTarget; label: string }) {
    const mountRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState("connecting...");
    const [failure, setFailure] = useState<Failure | null>(null);
    // Bumped by Retry: the session is keyed on it, so asking again is a fresh
    // ticket and a fresh socket rather than a reconnect of the dead one.
    const [attempt, setAttempt] = useState(0);
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
        setStatus("connecting...");

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
                setStatus(reason?.error ?? "could not authorize terminal");
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
                setStatus("connected");
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
                if (opened) {
                    setStatus("disconnected");
                    return;
                }
                const reason = event.reason.trim();
                setStatus(reason || "could not connect");
                setFailure(reason ? { kind: "refused", reason } : { kind: "unreachable" });
            };
            // Fires before the close on a connection that never opened; the close
            // handler has the code and reason, so this only avoids a silent gap.
            socket.onerror = () => !opened && setStatus("could not connect");

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
                <span>{status}</span>
            </div>
            <div
                ref={mountRef}
                className="h-80 w-full overflow-hidden rounded-md bg-[#0b0e14] p-2"
            />
            {failure ? (
                <FailureNote failure={failure} onRetry={() => setAttempt((n) => n + 1)} />
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
 */
function FailureNote({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
    return (
        <div className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-muted-foreground">
            <p className="flex items-start gap-2">
                <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
                {failure.kind === "refused" ? (
                    <span>The server refused the session: {failure.reason}.</span>
                ) : (
                    <span>
                        The browser would not open the connection. A terminal needs this
                        address&apos;s certificate trusted, and accepting the warning on the page is
                        not enough.{" "}
                        <a
                            href="/api/system/local-ca"
                            className="font-medium text-foreground underline underline-offset-2"
                        >
                            Download Polaris&apos;s certificate
                        </a>{" "}
                        and add it to this device&apos;s trusted roots, then reload.
                    </span>
                )}
            </p>
            <div>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                    <RotateCw className="size-3.5" /> Try again
                </Button>
            </div>
        </div>
    );
}
