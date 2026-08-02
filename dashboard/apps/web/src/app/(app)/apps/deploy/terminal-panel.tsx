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
import { useEffect, useRef, useState } from "react";

/** What to attach to: a container on a deploy target, a container on a
 *  Containers connection, or a registered server - as the Polaris login, or as
 *  root where that server granted it. */
export type TerminalTarget =
    | { kind: "container"; targetId: string; containerRef: string }
    | { kind: "docker"; connectionId: string; containerRef: string }
    | { kind: "host"; hostId: string; asRoot?: boolean };

export function TerminalPanel({ target, label }: { target: TerminalTarget; label: string }) {
    const mountRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState("connecting...");
    // The object identity of `target` would restart the session on every parent
    // render; its contents are what actually decide the connection.
    const key =
        target.kind === "host"
            ? `host:${target.hostId}:${target.asRoot ? "root" : "login"}`
            : target.kind === "docker"
              ? `docker:${target.connectionId}:${target.containerRef}`
              : `${target.targetId}:${target.containerRef}`;

    useEffect(() => {
        let disposed = false;
        let socket: WebSocket | undefined;
        let cleanup: (() => void) | undefined;

        async function start(): Promise<void> {
            const [{ Terminal }, { FitAddon }] = await Promise.all([
                import("@xterm/xterm"),
                import("@xterm/addon-fit")
            ]);
            if (disposed || !mountRef.current) return;

            const term = new Terminal({ fontSize: 13, cursorBlink: true, theme: { background: "#0b0e14" } });
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
                          : { targetId: target.targetId, containerRef: target.containerRef, mode: "terminal" }
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
                setStatus("connected");
                sendResize();
            };
            socket.onmessage = (event) => {
                term.write(event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : (event.data as string));
            };
            socket.onclose = () => setStatus("disconnected");
            socket.onerror = () => setStatus("connection error");

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
    }, [key]);

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{label}</span>
                <span>{status}</span>
            </div>
            <div ref={mountRef} className="h-80 w-full overflow-hidden rounded-md bg-[#0b0e14] p-2" />
        </div>
    );
}
