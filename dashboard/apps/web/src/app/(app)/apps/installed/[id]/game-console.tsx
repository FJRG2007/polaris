"use client";

/**
 * The server console: the container's own output, and a line to type into it.
 *
 * Commands go over RCON, which answers - so the reply is shown against the
 * command that caused it rather than left for the operator to find in the log,
 * where a command that was refused looks exactly like one that was never sent.
 *
 * Two things sit around the input, and they are deliberately not the same thing.
 * The kept commands are the server's: the handful of lines this particular server
 * is run with, stored on the install, so they survive a reload, a different
 * browser and a second operator. The history is one person's typing at one
 * keyboard, so it stays in that browser - but it is on screen now rather than
 * only reachable by pressing the up arrow, which is a feature nobody finds.
 */

import { useRuntimeLog } from "./use-runtime-log";
import { LogViewer } from "@/components/log-viewer";
import { GAME_RULES } from "@/lib/apps/minecraft/rules";
import { applyCompletion, completeConsole } from "@/lib/apps/console-complete";
import { recentItemsAction, sendConsoleCommandAction } from "./minecraft-actions";
import { CornerDownLeft, History, MoreHorizontal, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
    deleteConsoleCommandAction,
    listConsoleCommandsAction,
    saveConsoleCommandAction
} from "./console-actions";
import {
    MAX_SAVED_COMMAND,
    MAX_SAVED_LABEL,
    placeholderRange,
    type SavedCommand
} from "@/lib/apps/console-commands";
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    useTransition,
    type KeyboardEvent
} from "react";
import {
    Button,
    Card,
    CardBody,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    Input,
    cn
} from "@polaris/ui";

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

function writeHistory(installedAppId: string, history: readonly string[]): void {
    try {
        window.localStorage.setItem(historyKey(installedAppId), JSON.stringify(history));
    } catch {
        // A browser with storage turned off still gets the history for this
        // sitting; it simply does not outlive the tab.
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
    // back from the browser, so it survives the reload that used to empty it. Held
    // as a ref for the arrows - which must not re-render on every keystroke - and
    // mirrored into state for the menu that draws it.
    const history = useRef<string[]>([]);
    const [past, setPast] = useState<readonly string[]>([]);
    const cursor = useRef<number | null>(null);
    const input = useRef<HTMLInputElement | null>(null);
    const [caret, setCaret] = useState(0);
    const [items, setItems] = useState<readonly string[]>([]);
    /** Which suggestion is highlighted, or none - when none, the arrows walk the
     *  history instead, which is what they did before any of this. */
    const [choice, setChoice] = useState<number | null>(null);
    const [saved, setSaved] = useState<readonly SavedCommand[]>([]);
    /** The kept command being written, or null while the dialog is shut. */
    const [keeping, setKeeping] = useState<{ id?: string; label: string; command: string } | null>(null);
    const [keepError, setKeepError] = useState("");

    useEffect(() => {
        history.current = readHistory(installedAppId);
        setPast(history.current);
    }, [installedAppId]);

    useEffect(() => {
        void listConsoleCommandsAction(installedAppId).then((answer) => setSaved(answer.commands));
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

    /** Put a whole command in the box, with the blank to fill in selected when it
     *  has one - which is the only reason anybody would want the caret anywhere
     *  but the end. */
    const load = useCallback((command: string) => {
        setLine(command);
        setChoice(null);
        const blank = placeholderRange(command);
        setCaret(blank ? blank.end : command.length);
        requestAnimationFrame(() => {
            input.current?.focus();
            if (blank) input.current?.setSelectionRange(blank.start, blank.end);
            else input.current?.setSelectionRange(command.length, command.length);
        });
    }, []);

    const accept = useCallback(
        (option: string) => {
            put(applyCompletion(line, completion, option));
            setChoice(null);
        },
        [line, completion, put]
    );

    const submit = useCallback(
        (raw: string) => {
            const command = raw.trim();
            if (command.length === 0) return;
            history.current = [...history.current.filter((item) => item !== command), command].slice(-KEPT_HISTORY);
            setPast(history.current);
            cursor.current = null;
            setChoice(null);
            writeHistory(installedAppId, history.current);
            setLine("");
            setCaret(0);
            startTransition(async () => {
                const result = await sendConsoleCommandAction(installedAppId, command);
                const output = result.error ?? (result.output || "Done");
                setReplies((current) =>
                    [...current, { command, output, failed: Boolean(result.error) }].slice(-KEPT_REPLIES)
                );
                // The command usually produced log output too; show it without
                // waiting for the next poll.
                void refresh();
            });
        },
        [installedAppId, refresh]
    );

    /** Pressing a kept command. One that is complete runs; one with a blank in it
     *  lands in the box with the blank selected, because sending
     *  `Broadcast <message>` verbatim is never what anybody meant. */
    const pressSaved = useCallback(
        (entry: SavedCommand) => {
            if (placeholderRange(entry.command)) load(entry.command);
            else submit(entry.command);
        },
        [load, submit]
    );

    function keep(): void {
        if (!keeping) return;
        setKeepError("");
        startTransition(async () => {
            const result = await saveConsoleCommandAction({
                installedAppId,
                id: keeping.id,
                label: keeping.label,
                command: keeping.command
            });
            if (result.error || !result.commands) {
                setKeepError(result.error ?? "That command could not be kept");
                return;
            }
            setSaved(result.commands);
            setKeeping(null);
        });
    }

    function forget(id: string): void {
        startTransition(async () => {
            const result = await deleteConsoleCommandAction(installedAppId, id);
            if (result.commands) setSaved(result.commands);
        });
    }

    function clearHistory(): void {
        history.current = [];
        setPast([]);
        cursor.current = null;
        writeHistory(installedAppId, []);
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
            submit(line);
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

                {/* The commands this server is run with, above the box they would
                    otherwise be typed into. */}
                <div className="flex flex-wrap items-center gap-1.5">
                    {saved.map((entry) => (
                        <span
                            key={entry.id}
                            className="flex items-stretch overflow-hidden rounded-md border border-border bg-surface"
                        >
                            <button
                                type="button"
                                disabled={!running || pending}
                                onClick={() => pressSaved(entry)}
                                title={entry.command}
                                className="max-w-56 truncate px-2 py-1 text-xs transition-colors hover:bg-muted disabled:opacity-50"
                            >
                                {entry.label}
                            </button>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button
                                        type="button"
                                        aria-label={`More for ${entry.label}`}
                                        className="border-l border-border px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <MoreHorizontal className="size-3.5" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuLabel className="font-mono text-xs">
                                        {entry.command}
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onSelect={() => {
                                            setKeepError("");
                                            setKeeping({
                                                id: entry.id,
                                                label: entry.label,
                                                command: entry.command
                                            });
                                        }}
                                    >
                                        Edit
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onSelect={() => load(entry.command)}>
                                        Put it in the box
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                        className="text-danger"
                                        onSelect={() => forget(entry.id)}
                                    >
                                        <Trash2 className="size-4" /> Forget it
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </span>
                    ))}
                    <Button
                        size="xs"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => {
                            setKeepError("");
                            setKeeping({ label: "", command: line.trim() });
                        }}
                    >
                        <Plus className="size-3.5" /> Keep a command
                    </Button>
                </div>

                <div className="relative flex items-center gap-2">
                    {suggestions.length > 0 && (
                        // Above the box rather than at the caret. A list anchored to
                        // the caret has to measure text in a font it does not own,
                        // and being a few pixels wrong there is worse than being
                        // deliberately left-aligned here.
                        <ul className="absolute bottom-full left-0 z-10 mb-1 max-h-48 w-full max-w-md overflow-y-auto rounded-md border border-border-strong bg-surface py-1 shadow-popover">
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
                    {/* What was typed here before, including before the last
                        reload. The arrows still walk it; this is so somebody who
                        does not know that can see it. */}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon"
                                aria-label="Commands you have run"
                                title="Commands you have run"
                            >
                                <History className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                            <DropdownMenuLabel>Commands you have run</DropdownMenuLabel>
                            <DropdownMenuSeparator />
                            {past.length === 0 ? (
                                <DropdownMenuItem disabled>Nothing yet</DropdownMenuItem>
                            ) : (
                                [...past].reverse().map((command, index) => (
                                    <DropdownMenuItem
                                        key={`${command}-${index}`}
                                        className="font-mono text-xs"
                                        onSelect={() => load(command)}
                                    >
                                        <span className="max-w-72 truncate" title={command}>{command}</span>
                                    </DropdownMenuItem>
                                ))
                            )}
                            {past.length > 0 && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem className="text-danger" onSelect={clearHistory}>
                                        <Trash2 className="size-4" /> Clear the history
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button onClick={() => submit(line)} disabled={!running || pending || line.trim().length === 0}>
                        <CornerDownLeft className="size-4" /> Send
                    </Button>
                </div>

                {keeping && (
                    <Dialog open onOpenChange={(open: boolean) => !open && setKeeping(null)}>
                        <DialogContent>
                            <DialogHeader>
                                <DialogTitle>{keeping.id ? "Edit the command" : "Keep a command"}</DialogTitle>
                                <DialogDescription>
                                    It sits above the console for everybody who runs this server. Put
                                    a blank in angle brackets - <code>Broadcast &lt;message&gt;</code>{" "}
                                    - and pressing it fills the box instead of sending.
                                </DialogDescription>
                            </DialogHeader>
                            <div className="flex flex-col gap-3">
                                <label className="flex flex-col gap-1">
                                    <span className="text-sm font-medium">Command</span>
                                    <Input
                                        autoFocus
                                        value={keeping.command}
                                        maxLength={MAX_SAVED_COMMAND}
                                        className="font-mono"
                                        placeholder={hint}
                                        onChange={(event) =>
                                            setKeeping({ ...keeping, command: event.target.value })
                                        }
                                    />
                                </label>
                                <label className="flex flex-col gap-1">
                                    <span className="text-sm font-medium">Name</span>
                                    <Input
                                        value={keeping.label}
                                        maxLength={MAX_SAVED_LABEL}
                                        placeholder="The command itself, if you leave this empty"
                                        onChange={(event) =>
                                            setKeeping({ ...keeping, label: event.target.value })
                                        }
                                    />
                                </label>
                                {keepError && (
                                    <p role="alert" className="text-sm text-danger">
                                        {keepError}
                                    </p>
                                )}
                            </div>
                            <DialogFooter>
                                <Button variant="ghost" onClick={() => setKeeping(null)}>
                                    Cancel
                                </Button>
                                <Button
                                    onClick={keep}
                                    disabled={pending || keeping.command.trim().length === 0}
                                >
                                    Keep it
                                </Button>
                            </DialogFooter>
                        </DialogContent>
                    </Dialog>
                )}
            </CardBody>
        </Card>
    );
}
