"use client";

/**
 * The console's terminal: what the server prints, live, and a prompt to type at.
 *
 * Output comes over the terminal socket (`/api/deploy/ws`, a `console` ticket
 * minted by `openConsoleStreamAction` for somebody holding `games.console`):
 * the recent lines first, then each one as it is printed - the shape of
 * Pterodactyl's console, whose socket replays the log on connect and then sends
 * "console output" events. A server the socket cannot follow (one on another
 * machine) is read by polling as before, into the same terminal.
 *
 * Input never travels on the socket. A typed line is handed to `onSubmit`, the
 * same path the box below takes, so it is checked and audited line by line.
 */

import { hostUi } from "@polaris/app-host/client";
import { openConsoleStreamAction } from "./console-actions";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import {
    CONSOLE_PROMPT,
    EMPTY_LINE,
    createConsoleOutput,
    editLine,
    newSince,
    promptRow,
    replyRows,
    type LineState
} from "../../lib/console-stream";

const { useRuntimeLog } = hostUi.appAppsInstalledIdUseRuntimeLog;
const { TerminalView } = hostUi.terminalView;

type Transport = ComponentProps<typeof TerminalView>["transport"];
type Sink = Parameters<Transport>[0];

/** How long after the stream ends it is asked for again while the server runs. */
const RECONNECT_MS = 5_000;
/** How often the kept log is handed to the checks that read it. */
const LOG_EVERY_MS = 2_000;

export type ConsoleStatus = "connecting" | "live" | "polling" | "ended" | "refused";

export function useConsoleStream({
    installedAppId,
    applicationId,
    running,
    history,
    onSubmit
}: {
    installedAppId: string;
    applicationId: string | null;
    running: boolean;
    /** Past commands, newest last, for the arrows at the prompt. */
    history: () => readonly string[];
    onSubmit: (line: string) => void;
}): {
    transport: Transport;
    transportKey: string;
    status: ConsoleStatus;
    /** The recent raw output, for the checks that read the log. */
    log: string;
    refresh: () => Promise<void>;
    /** Write a command's answer into the terminal. */
    writeReply: (command: string, output: string, failed: boolean) => void;
} {
    const [status, setStatus] = useState<ConsoleStatus>("connecting");
    const [attempt, setAttempt] = useState(0);
    const [streamLog, setStreamLog] = useState("");
    const sink = useRef<Sink | null>(null);
    const typed = useRef<LineState>(EMPTY_LINE);
    const callbacks = useRef({ history, onSubmit });
    callbacks.current = { history, onSubmit };

    // Polled only for a server the socket cannot follow.
    const polled = useRuntimeLog(status === "polling" ? applicationId : null, true, 400);
    const shown = useRef("");

    /** Write output above the prompt, then draw the prompt and the typed line again. */
    const above = useCallback((rows: string) => {
        if (!rows || !sink.current) return;
        sink.current.write(`\r\x1b[K${rows}${CONSOLE_PROMPT}${typed.current.line}`);
    }, []);

    const transport: Transport = useCallback(
        (next) => {
            let disposed = false;
            let socket: WebSocket | undefined;
            let retry: ReturnType<typeof setTimeout> | undefined;
            sink.current = next;
            shown.current = "";
            const output = createConsoleOutput();
            next.write(promptRow(typed.current.line));
            next.input((data) => {
                const edit = editLine(typed.current, data, callbacks.current.history());
                typed.current = edit.state;
                if (edit.echo) next.write(edit.echo);
                for (const line of edit.submit) callbacks.current.onSubmit(line);
            });
            setStatus("connecting");
            const publish = setInterval(() => setStreamLog(output.log()), LOG_EVERY_MS);

            void (async () => {
                const answer = await openConsoleStreamAction(installedAppId).catch(() => null);
                if (disposed) return;
                if (!answer || "refused" in answer) {
                    setStatus("refused");
                    return;
                }
                if (!("token" in answer)) {
                    setStatus("polling");
                    return;
                }
                const scheme = window.location.protocol === "https:" ? "wss" : "ws";
                const ws = new WebSocket(`${scheme}://${window.location.host}/api/deploy/ws`, answer.token);
                socket = ws;
                ws.binaryType = "arraybuffer";
                const decoder = new TextDecoder();
                ws.onopen = () => setStatus("live");
                ws.onmessage = (event) => {
                    const text =
                        event.data instanceof ArrayBuffer
                            ? decoder.decode(new Uint8Array(event.data), { stream: true })
                            : String(event.data);
                    above(output.push(text));
                };
                ws.onclose = () => {
                    if (disposed) return;
                    setStatus("ended");
                    // A server that stopped prints nothing more; one that restarted
                    // is followed again, from a fresh ticket.
                    if (running) retry = setTimeout(() => setAttempt((n) => n + 1), RECONNECT_MS);
                };
            })();

            return () => {
                disposed = true;
                clearInterval(publish);
                if (retry) clearTimeout(retry);
                socket?.close();
                next.input(null);
                if (sink.current === next) sink.current = null;
            };
        },
        [installedAppId, running, above]
    );

    // A polled read writes only what it adds to the last one.
    useEffect(() => {
        if (status !== "polling" || !polled.log) return;
        const added = newSince(shown.current, polled.log);
        shown.current = polled.log;
        if (added) above(createConsoleOutput().push(`${added}\n`));
    }, [status, polled.log, above]);

    const writeReply = useCallback(
        (command: string, output: string, failed: boolean) => above(replyRows(command, output, failed)),
        [above]
    );

    const refresh = useCallback(
        async () => (status === "polling" ? polled.refresh() : undefined),
        [status, polled]
    );

    return {
        transport,
        transportKey: `${installedAppId}:${running ? "on" : "off"}:${attempt}`,
        status,
        log: status === "polling" ? polled.log : streamLog,
        refresh,
        writeReply
    };
}
