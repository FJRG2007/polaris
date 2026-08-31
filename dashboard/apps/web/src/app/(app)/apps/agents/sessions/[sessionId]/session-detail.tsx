"use client";

/**
 * One session: what it is doing, what has been said to it, and the box you say
 * the next thing in.
 *
 * Three readouts, and they answer different questions. The transcript is what
 * somebody would read to catch up. The activity strip is what the agent is doing
 * right now, which is a different thing from what it has been told. And the
 * screen is the agent's own terminal, for the moments when the summary is not
 * enough and you want to see what it actually printed.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";
import type { SessionView } from "@/lib/agents/session-service";
import { useEffect, useRef, useState, useTransition } from "react";
import { CircleDot, Loader2, Send, Square, TriangleAlert } from "lucide-react";
import { TerminalPanel } from "../../../deploy/terminal-panel";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Textarea } from "@polaris/ui";
import { interruptSessionAction, promptSessionAction, sessionScreenAction, stopSessionAction } from "../actions";

/** Fast while something is happening. A session that has finished polls nothing. */
const REFRESH_MS = 3000;

const TONE: Record<core.AgentSessionState, string> = {
    starting: "text-muted-foreground",
    working: "text-violet-400",
    waiting: "text-amber-400",
    idle: "text-foreground",
    stopped: "text-muted-foreground",
    failed: "text-red-400"
};

/** How each event reads on the strip. Written as what happened rather than as the
 *  event's own name, because nobody outside this codebase knows what `tool.start`
 *  is and everybody knows what "ran" means. */
const EVENT_LABELS: Record<string, string> = {
    "session.start": "Started",
    prompt: "Asked",
    "tool.start": "Running",
    "tool.end": "Done",
    "tool.failed": "Failed",
    permission: "Asking permission",
    question: "Waiting for you",
    "subagent.start": "Started a subagent",
    "subagent.end": "Subagent finished",
    compact: "Compacting its context",
    "turn.end": "Finished a turn",
    "session.end": "Ended",
    error: "Error"
};

interface Props {
    session: SessionView;
    events: { kind: string; detail: string; subject: string; at: string }[];
    messages: { role: string; body: string; authorId: string | null; at: string }[];
}

export function SessionDetail({ session, events, messages }: Props) {
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [screen, setScreen] = useState<string | null>(null);
    const [attached, setAttached] = useState(false);
    const [busy, startTransition] = useTransition();
    const router = useRouter();
    const bottom = useRef<HTMLDivElement>(null);

    const over = core.isSessionOver(session.state);

    useEffect(() => {
        if (over) return;
        const timer = setInterval(() => router.refresh(), REFRESH_MS);
        return () => clearInterval(timer);
    }, [over, router]);

    useEffect(() => {
        bottom.current?.scrollIntoView({ block: "end" });
    }, [messages.length, events.length]);

    const send = () => {
        const body = text.trim();
        if (!body) return;
        // Cleared before the round trip. What was sent is already on the way, and a
        // box that stays full reads as a message that did not go.
        setText("");
        startTransition(() => {
            void runAction(() => promptSessionAction({ sessionId: session.id, text: body }), setError).then(
                (result) => {
                    if (result?.error) {
                        setError(result.error);
                        setText(body);
                    }
                }
            );
        });
    };

    const interrupt = () => {
        startTransition(() => {
            void runAction(() => interruptSessionAction(session.id), setError).then((result) => {
                if (result?.error) setError(result.error);
            });
        });
    };

    const stop = () => {
        startTransition(() => {
            void runAction(() => stopSessionAction(session.id), setError).then((result) => {
                if (result?.error) setError(result.error);
            });
        });
    };

    const look = () => {
        startTransition(() => {
            void runAction(() => sessionScreenAction(session.id), setError).then((result) => {
                if (result?.error) setError(result.error);
                else setScreen(result?.screen ?? "");
            });
        });
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <CircleDot className={`size-4 shrink-0 ${TONE[session.state]}`} />
                <span className={`text-sm ${TONE[session.state]}`}>
                    {core.AGENT_SESSION_STATE_LABELS[session.state]}
                </span>
                {session.detail ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={session.detail}>{session.detail}</span>
                ) : (
                    <span className="flex-1" />
                )}
                <Badge variant="neutral" className="shrink-0">
                    {core.agentCliById(session.cli)?.label ?? session.command ?? session.cli}
                </Badge>
                <Badge variant="neutral" className="shrink-0">
                    {session.place === "host" ? (session.hostName ?? "a server") : "this box"}
                </Badge>
                {over ? null : (
                    <>
                        {session.place === "local" ? (
                            <Button size="sm" variant="ghost" onClick={() => setAttached((open) => !open)}>
                                {attached ? "Detach" : "Take the terminal"}
                            </Button>
                        ) : null}
                        <Button size="sm" variant="ghost" onClick={look} disabled={busy}>
                            See its screen
                        </Button>
                        <Button size="sm" variant="ghost" onClick={interrupt} disabled={busy}>
                            Interrupt
                        </Button>
                        <Button size="sm" variant="ghost" onClick={stop} disabled={busy}>
                            <Square className="size-4 shrink-0" />
                            Stop
                        </Button>
                    </>
                )}
            </div>

            {session.error ? (
                <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                    <span>{session.error}</span>
                </div>
            ) : null}
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            {attached ? (
                <Card>
                    <CardHeader>
                        <CardTitle>The agent&apos;s terminal</CardTitle>
                    </CardHeader>
                    <CardBody>
                        {/* Attached, not a second shell beside it: this is the same
                            terminal the agent is running in, so what is typed here
                            goes to the agent and detaching leaves it working. */}
                        <TerminalPanel target={{ kind: "agent", sessionId: session.id }} label={session.title} />
                    </CardBody>
                </Card>
            ) : null}

            {screen !== null ? (
                <Card>
                    <CardHeader>
                        <CardTitle>What the agent&apos;s terminal shows</CardTitle>
                    </CardHeader>
                    <CardBody>
                        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-sunken p-3 text-xs leading-relaxed">
                            {screen || "Nothing on it yet."}
                        </pre>
                    </CardBody>
                </Card>
            ) : null}

            <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
                <Card>
                    <CardHeader>
                        <CardTitle>Conversation</CardTitle>
                    </CardHeader>
                    <CardBody className="space-y-3">
                        {messages.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Nothing has been said yet. Whatever you send below goes straight into the agent.
                            </p>
                        ) : (
                            messages.map((message, index) => (
                                <div key={`${message.at}-${index}`} className="space-y-1">
                                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                                        {message.role === "user"
                                            ? "You"
                                            : message.role === "agent"
                                              ? "Agent"
                                              : "Polaris"}
                                    </p>
                                    <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                                </div>
                            ))
                        )}
                        <div ref={bottom} />
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle>Activity</CardTitle>
                    </CardHeader>
                    <CardBody>
                        {events.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                The agent has not reported anything yet. It reports through its own hooks, which
                                take effect once it has started.
                            </p>
                        ) : (
                            <ul className="space-y-1.5">
                                {events.slice(-40).map((event, index) => (
                                    <li key={`${event.at}-${index}`} className="text-xs">
                                        <span className="text-muted-foreground">
                                            {EVENT_LABELS[event.kind] ?? event.kind}
                                        </span>
                                        {event.detail ? <span className="ml-1.5">{event.detail}</span> : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            </div>

            {over ? (
                <p className="text-sm text-muted-foreground">
                    This session has ended. Its branch, {session.branch}, is still there.
                </p>
            ) : (
                <div className="space-y-2">
                    <Textarea
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                        rows={3}
                        placeholder={
                            session.state === "waiting"
                                ? "It is waiting on you. Answer it here."
                                : "Send it the next thing."
                        }
                        onKeyDown={(event) => {
                            // Enter sends, Shift+Enter is a newline - the shape every
                            // message box has, and the one people will try first.
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                send();
                            }
                        }}
                    />
                    <div className="flex justify-end">
                        <Button size="sm" onClick={send} disabled={busy || !text.trim()}>
                            {busy ? (
                                <Loader2 className="size-4 shrink-0 animate-spin" />
                            ) : (
                                <Send className="size-4 shrink-0" />
                            )}
                            Send
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
