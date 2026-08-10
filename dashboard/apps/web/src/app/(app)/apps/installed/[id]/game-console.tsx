"use client";

/**
 * The server console: the container's own output, and a line to type into it.
 *
 * Commands go over RCON, which answers - so the reply is shown against the
 * command that caused it rather than left for the operator to find in the log,
 * where a command that was refused looks exactly like one that was never sent.
 */

import { useRuntimeLog } from "./use-runtime-log";
import { LogViewer } from "@/components/log-viewer";
import { CornerDownLeft, RefreshCw } from "lucide-react";
import { Button, Card, CardBody, Input } from "@polaris/ui";
import { sendConsoleCommandAction } from "./minecraft-actions";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";

/** One command and what the server said back. */
interface Reply {
    readonly command: string;
    readonly output: string;
    readonly failed: boolean;
}

const KEPT_REPLIES = 12;

export function GameConsole({
    installedAppId,
    applicationId,
    running,
    logName = "minecraft",
    hint = "say Hello, or time set day"
}: {
    installedAppId: string;
    applicationId: string | null;
    running: boolean;
    /** What a downloaded copy of the log is called. */
    logName?: string;
    /** An example command, in the language of the game this console is attached
     *  to - the two do not share a single command. */
    hint?: string;
}) {
    const { log, refresh } = useRuntimeLog(applicationId, true, 400);
    const [line, setLine] = useState("");
    const [replies, setReplies] = useState<Reply[]>([]);
    const [pending, startTransition] = useTransition();
    // Command history, newest last, walked with the arrow keys like a shell.
    const history = useRef<string[]>([]);
    const cursor = useRef<number | null>(null);

    function send(): void {
        const command = line.trim();
        if (command.length === 0) return;
        history.current = [...history.current.filter((item) => item !== command), command].slice(-50);
        cursor.current = null;
        setLine("");
        startTransition(async () => {
            const result = await sendConsoleCommandAction(installedAppId, command);
            const output = result.error ?? (result.output || "Done");
            setReplies((current) => [...current, { command, output, failed: Boolean(result.error) }].slice(-KEPT_REPLIES));
            // The command usually produced log output too; show it without waiting
            // for the next poll.
            void refresh();
        });
    }

    function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
        if (event.key === "Enter") {
            event.preventDefault();
            send();
            return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        if (history.current.length === 0) return;
        event.preventDefault();
        const last = history.current.length - 1;
        const next =
            event.key === "ArrowUp"
                ? Math.max(0, cursor.current === null ? last : cursor.current - 1)
                : cursor.current === null
                  ? null
                  : cursor.current >= last
                    ? null
                    : cursor.current + 1;
        cursor.current = next;
        setLine(next === null ? "" : (history.current[next] ?? ""));
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium">Console</p>
                    <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label="Refresh the console" title="Refresh the console">
                        <RefreshCw className="size-4" />
                    </Button>
                </div>

                <LogViewer
                    log={log}
                    name={logName}
                    searchable
                    emptyText={running ? "Waiting for output..." : "The server is stopped."}
                    className="h-96"
                />

                {replies.length > 0 && (
                    <div className="flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface p-2 font-mono text-xs">
                        {replies.map((reply, index) => (
                            <div key={`${reply.command}-${index}`} className="flex flex-col">
                                <span className="text-muted-foreground">&gt; {reply.command}</span>
                                <span className={reply.failed ? "text-danger" : ""}>{reply.output}</span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="flex items-center gap-2">
                    <Input
                        value={line}
                        onChange={(event) => setLine(event.target.value)}
                        onKeyDown={onKeyDown}
                        placeholder={running ? hint : "Start the server to send commands"}
                        disabled={!running || pending}
                        aria-label="Server command"
                        className="font-mono"
                    />
                    <Button onClick={send} disabled={!running || pending || line.trim().length === 0}>
                        <CornerDownLeft className="size-4" /> Send
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}
