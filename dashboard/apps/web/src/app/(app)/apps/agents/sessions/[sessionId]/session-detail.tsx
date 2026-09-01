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
import { TerminalPanel } from "@/app/(app)/apps/deploy/terminal-panel";
import { bootProgress, type BootStep } from "@/lib/agents/boot-progress";
import { Check, CircleDot, Loader2, Send, Square, TriangleAlert } from "lucide-react";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Textarea } from "@polaris/ui";
import {
    interruptSessionAction,
    promptSessionAction,
    sessionScreenAction,
    stopSessionAction
} from "../actions";

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
    /**
     * What has been typed and not yet come back from the server.
     *
     * A session page re-reads itself on a timer, so a message sent between two
     * of those reads was invisible for up to four seconds - the box emptied and
     * nothing appeared, which reads as a message that went nowhere. These are
     * shown under the conversation until the server's copy arrives, and a queue
     * rather than one because typing the next thing should never wait for the
     * last one to land.
     */
    const [pending, setPending] = useState<{ key: number; body: string }[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [screen, setScreen] = useState<string | null>(null);
    /**
     * Where the boot has got to, while it is still booting.
     *
     * Read off the session's own terminal rather than reported: every step of it
     * happens before there is an agent to run a hook. What it replaces is a word
     * and a spinner for anything between twenty seconds and five minutes, with
     * no way to tell a slow clone from a machine that had already given up.
     */
    const [boot, setBoot] = useState<BootStep[] | null>(null);
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

    // Only while it is starting. After that the terminal belongs to the agent
    // and reading it on a timer would be polling somebody's session for a bar
    // that has nothing left to say.
    useEffect(() => {
        if (session.state !== "starting") {
            setBoot(null);
            return;
        }
        let stopped = false;
        const read = () => {
            void sessionScreenAction(session.id)
                .then((result) => {
                    if (stopped) return;
                    setBoot(bootProgress(result?.screen ?? ""));
                })
                // A machine part way through its boot refuses the probe as often
                // as it answers, and neither is a reason to show an error over a
                // progress readout.
                .catch(() => undefined);
        };
        read();
        const timer = setInterval(read, REFRESH_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [session.id, session.state]);

    // The server's copy has landed, so the local one goes. Matched on the body
    // rather than an id, because the row the server writes has one of its own
    // and the two were never the same message twice.
    useEffect(() => {
        if (pending.length === 0) return;
        const said = new Set(
            messages.filter((message) => message.role === "user").map((one) => one.body)
        );
        setPending((queue) => queue.filter((one) => !said.has(one.body)));
        // Only when the server's list changes; `pending` is read, never depended on.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages]);

    const send = () => {
        const body = text.trim();
        if (!body) return;
        // Cleared and shown at once. What was sent is already on the way, and a
        // box that stays full reads as a message that did not go - while a
        // conversation that does not show it reads as one that was lost.
        setText("");
        const key = Date.now() + Math.random();
        setPending((queue) => [...queue, { key, body }]);
        setError(null);
        // Deliberately outside a transition: a transition makes the next send
        // wait for this one, and somebody typing three things in a row should
        // not be queueing behind a round trip they cannot see.
        void runAction(
            () => promptSessionAction({ sessionId: session.id, text: body }),
            setError
        ).then((result) => {
            if (result?.error) {
                // Rolled back, and the text handed back rather than lost:
                // it is the only copy of what they wrote.
                setPending((queue) => queue.filter((one) => one.key !== key));
                setError(result.error);
                setText((current) => (current ? current : body));
                return;
            }
            router.refresh();
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
                    {core.sessionStateLabel(session.state, session.lastEventAt !== null)}
                </span>
                {session.detail ? (
                    <span
                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        title={session.detail}
                    >
                        {session.detail}
                    </span>
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
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setAttached((open) => !open)}
                            >
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

            {boot ? (
                <Card>
                    <CardBody className="space-y-3">
                        <div className="flex items-center gap-2">
                            <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" />
                            <p className="text-sm">Getting the machine ready.</p>
                        </div>
                        {/* The bar and the list say different things, and both
                            are wanted: the bar is "how much longer", the list is
                            "what is it doing", and the second is what makes a
                            stuck step legible instead of a bar that stopped. */}
                        <div className="bg-surface-sunken h-1.5 w-full overflow-hidden rounded-full">
                            <div
                                className="bg-primary h-full rounded-full transition-all duration-500"
                                style={{
                                    width: `${Math.round(
                                        (boot.filter((step) => step.state === "done").length /
                                            boot.length) *
                                            100
                                    )}%`
                                }}
                            />
                        </div>
                        <ul className="space-y-1">
                            {boot.map((step) => (
                                <li key={step.key} className="flex items-center gap-2 text-xs">
                                    {step.state === "done" ? (
                                        <Check className="size-3.5 shrink-0 text-emerald-400" />
                                    ) : step.state === "doing" ? (
                                        <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
                                    ) : (
                                        <span className="bg-border size-1.5 shrink-0 rounded-full" />
                                    )}
                                    <span
                                        className={
                                            step.state === "waiting"
                                                ? "text-muted-foreground"
                                                : undefined
                                        }
                                    >
                                        {step.label}
                                    </span>
                                </li>
                            ))}
                        </ul>
                        {/* Said here rather than only in the terminal, because
                            this is the screen somebody is on while they wonder
                            whether it is always going to be this slow. */}
                        <p className="text-muted-foreground text-xs">
                            The installs happen once. This machine keeps its home, so your next
                            session skips them and starts in seconds.
                        </p>
                    </CardBody>
                </Card>
            ) : null}

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
                        <TerminalPanel
                            target={{ kind: "agent", sessionId: session.id }}
                            label={session.title}
                        />
                        {/* Said here because this is where somebody meets it. An
                            agent with no account linked comes up on its own login
                            prompt, and being asked to sign in on a machine you
                            cannot see, with no word on whether it will ask again,
                            is the reason this looked broken. It will not: the
                            home this runs in is kept between sessions. */}
                        <p className="text-muted-foreground mt-3 text-xs">
                            If the agent asks you to sign in, do it here. This machine keeps its
                            home between sessions, so it only asks once.
                        </p>
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
                                Nothing has been said yet. Whatever you send below goes straight
                                into the agent.
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
                                    <p className="whitespace-pre-wrap break-words text-sm">
                                        {message.body}
                                    </p>
                                </div>
                            ))
                        )}

                        {/* Sent, not yet echoed back. Dimmed rather than marked
                            as failing: nothing has gone wrong, the server has
                            simply not been re-read yet. */}
                        {pending.map((one) => (
                            <div key={one.key} className="space-y-1 opacity-60">
                                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                                    You
                                </p>
                                <p className="whitespace-pre-wrap break-words text-sm">
                                    {one.body}
                                </p>
                            </div>
                        ))}
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
                                The agent has not reported anything yet. It reports through its own
                                hooks, which take effect once it has started.
                            </p>
                        ) : (
                            <ul className="space-y-1.5">
                                {events.slice(-40).map((event, index) => (
                                    <li key={`${event.at}-${index}`} className="text-xs">
                                        <span className="text-muted-foreground">
                                            {EVENT_LABELS[event.kind] ?? event.kind}
                                        </span>
                                        {event.detail ? (
                                            <span className="ml-1.5">{event.detail}</span>
                                        ) : null}
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
                        {/* Not held by `busy`: that is the terminal or a stop
                            in flight, and neither is a reason somebody cannot
                            type the next thing. Sending is its own path and
                            queues on the screen. */}
                        <Button size="sm" onClick={send} disabled={!text.trim()}>
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
