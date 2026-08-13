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
import { GAME_RULES } from "@/lib/apps/minecraft/rules";
import { CornerDownLeft, RefreshCw } from "lucide-react";
import { Button, Card, CardBody, Input, cn } from "@polaris/ui";
import { recentItemsAction, sendConsoleCommandAction } from "./minecraft-actions";
import { applyCompletion, completeConsole } from "@/lib/apps/console-complete";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition, type KeyboardEvent } from "react";

/** One command and what the server said back. */
interface Reply {
    readonly command: string;
    readonly output: string;
    readonly failed: boolean;
}

const KEPT_REPLIES = 12;

/** How many past commands are remembered, and where.
 *
 *  Kept in the browser rather than on the server: this is one person's habits at
 *  one keyboard, not a property of the server, and a shared history would put one
 *  operator's typing in front of another's. Per server, because the commands people
 *  run on one are not the commands they run on another. */
const KEPT_HISTORY = 50;
const historyKey = (installedAppId: string): string => `polaris.console.history.${installedAppId}`;

function readHistory(installedAppId: string): string[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(historyKey(installedAppId));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}

export function GameConsole({
    installedAppId,
    applicationId,
    running,
    logName = "minecraft",
    hint = "say Hello, or time set day",
    game = "java",
    players = []
}: {
    installedAppId: string;
    applicationId: string | null;
    running: boolean;
    /** Which command table to complete from. The three do not share a command. */
    game?: "java" | "bedrock" | "ark";
    /** Who is on, for the arguments that name a player. The panel is already
     *  drawing this list, so completing from it costs nothing. */
    players?: readonly string[];
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
    // Command history, newest last, walked with the arrow keys like a shell. Read
    // back from the browser, so it survives the reload that used to empty it.
    const history = useRef<string[]>([]);
    const cursor = useRef<number | null>(null);
    const input = useRef<HTMLInputElement | null>(null);
    const [caret, setCaret] = useState(0);
    const [items, setItems] = useState<readonly string[]>([]);
    /** Which suggestion is highlighted, or none - when none, the arrows walk the
     *  history instead, which is what they did before any of this. */
    const [choice, setChoice] = useState<number | null>(null);

    useEffect(() => {
        history.current = readHistory(installedAppId);
    }, [installedAppId]);

    // The items this server has actually been handing out, which is a far better
    // list to complete from than every item in the game: somebody who gave out
    // diamonds yesterday is giving out diamonds today.
    useEffect(() => {
        if (game === "ark") return;
        void recentItemsAction(installedAppId).then((answer) => setItems(answer.items));
    }, [installedAppId, game]);

    const rules = useMemo(() => GAME_RULES.map((rule) => rule.id), []);
    const completion = useMemo(
        () => completeConsole(line, caret, { game, players, items, rules }),
        [line, caret, game, players, items, rules]
    );
    /** Only worth drawing when it would say something the typist does not already
     *  know: a single option identical to what is typed is not a suggestion. */
    const suggestions = useMemo(
        () => (completion.options.length === 1 && completion.options[0] === completion.token ? [] : completion.options),
        [completion]
    );

    const put = useCallback((next: { line: string; caret: number }) => {
        setLine(next.line);
        setCaret(next.caret);
        // The caret has to be moved on the element itself; React only owns the
        // value. Done after paint, or it is set on the old text and jumps back.
        requestAnimationFrame(() => input.current?.setSelectionRange(next.caret, next.caret));
    }, []);

    const accept = useCallback(
        (option: string) => {
            put(applyCompletion(line, completion, option));
            setChoice(null);
        },
        [line, completion, put]
    );

    function send(): void {
        const command = line.trim();
        if (command.length === 0) return;
        history.current = [...history.current.filter((item) => item !== command), command].slice(-KEPT_HISTORY);
        cursor.current = null;
        setChoice(null);
        try {
            window.localStorage.setItem(historyKey(installedAppId), JSON.stringify(history.current));
        } catch {
            // A browser with storage turned off still gets the history for this
            // sitting; it simply does not outlive the tab.
        }
        setLine("");
        setCaret(0);
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
        const open = suggestions.length > 0;

        // Tab is the one key that only ever means "finish this word".
        if (event.key === "Tab" && open) {
            event.preventDefault();
            accept(suggestions[choice ?? 0] ?? "");
            return;
        }
        if (event.key === "Escape" && choice !== null) {
            event.preventDefault();
            setChoice(null);
            return;
        }
        if (event.key === "Enter") {
            event.preventDefault();
            // Completes before it sends, rather than instead of sending: somebody
            // who has picked a suggestion and pressed Enter meant to take it, and
            // somebody who has not meant to send what they typed.
            if (open && choice !== null) {
                accept(suggestions[choice] ?? "");
                return;
            }
            send();
            return;
        }
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;

        // The arrows belong to the suggestion list while it is showing something
        // chosen, and to the history otherwise.
        if (open) {
            event.preventDefault();
            const last = suggestions.length - 1;
            if (event.key === "ArrowDown") setChoice(choice === null ? 0 : Math.min(last, choice + 1));
            else setChoice(choice === null ? last : choice === 0 ? null : choice - 1);
            return;
        }

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
        const recalled = next === null ? "" : (history.current[next] ?? "");
        put({ line: recalled, caret: recalled.length });
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

                <div className="relative flex items-center gap-2">
                    {suggestions.length > 0 && (
                        // Above the box rather than at the caret. A list anchored to
                        // the caret has to measure text in a font it does not own,
                        // and being a few pixels wrong there is worse than being
                        // deliberately left-aligned here.
                        <ul className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full max-w-md overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg">
                            {suggestions.map((option, index) => (
                                <li key={option}>
                                    <button
                                        type="button"
                                        className={cn(
                                            "flex w-full px-3 py-1 text-left font-mono text-xs hover:bg-muted",
                                            index === choice && "bg-muted"
                                        )}
                                        // The press has to not steal focus from the
                                        // box, or the caret it is about to move is
                                        // somewhere else by the time it moves it.
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => accept(option)}
                                    >
                                        {option}
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                    <Input
                        ref={input}
                        value={line}
                        onChange={(event) => {
                            setLine(event.target.value);
                            setCaret(event.target.selectionStart ?? event.target.value.length);
                            setChoice(null);
                        }}
                        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                        onBlur={() => setChoice(null)}
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
