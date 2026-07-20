"use client";

/**
 * Interactive terminal. Mints a one-shot ticket, opens a WebSocket to the deploy
 * sidecar presenting the token over Sec-WebSocket-Protocol, and wires xterm.js to
 * it: server output -> terminal, keystrokes -> server, and a resize control frame
 * on fit. xterm is imported dynamically so it stays out of the server bundle.
 */

import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";

export function TerminalPanel({
    targetId,
    containerRef,
    label
}: {
    targetId: string;
    containerRef: string;
    label: string;
}) {
    const mountRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState("connecting...");

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
                body: JSON.stringify({ targetId, containerRef, mode: "terminal" })
            });
            if (!res.ok) {
                setStatus("could not authorize terminal");
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
    }, [targetId, containerRef]);

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
