"use client";

/**
 * A session's conversation as a chat: what was asked - in Polaris or straight
 * into the terminal - what the agent answered, and the tools it ran, folded.
 *
 * The page renders with the newest page already in hand, so it paints at once
 * and is re-read in the background; the list is only swapped when what came
 * back differs. Older pages are loaded upward on request, and only that strip
 * shows a skeleton while one is on the way.
 */

import * as polls from "../sessions-polls";
import { agentText } from "@/lib/agents/words";
import { CodeSurface } from "@/components/code-surface";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Skeleton, pollWhileVisible } from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ChevronRight, TriangleAlert, Wrench } from "lucide-react";
import type { HistoryMessage } from "@/lib/agents/session-history";
import { promptKey } from "@/lib/agents/transcript-decoders";

/** How often an open session re-reads its history. Each read may run a command
 *  on the session's machine, which the server claims once every few seconds. */
const HISTORY_MS = 5000;

export interface HistoryPage {
    messages: HistoryMessage[];
    older: boolean;
}

interface Props {
    sessionId: string;
    initial: HistoryPage;
    /** Whether the session is still running, and so still worth re-reading. */
    live: boolean;
    /** Sent from this page and not yet back from the server. */
    pending: { key: number; body: string }[];
    /** Every prompt body the history now holds, so the page can drop its
     *  pending copies. */
    onUserBodies?: (bodies: Set<string>) => void;
}

function sameList(a: HistoryMessage[], b: HistoryMessage[]): boolean {
    return a.length === b.length && a.every((one, index) => one.id === b[index]!.id);
}

export function SessionHistory({ sessionId, initial, live, pending, onUserBodies }: Props) {
    const t = useTranslations("agents");
    const [latest, setLatest] = useState(initial.messages);
    const [earlier, setEarlier] = useState<HistoryMessage[]>([]);
    const [older, setOlder] = useState(initial.older);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [olderFailed, setOlderFailed] = useState(false);
    const bottom = useRef<HTMLDivElement>(null);
    const latestRef = useRef(latest);
    latestRef.current = latest;
    const earlierRef = useRef(earlier);
    earlierRef.current = earlier;

    // A page re-rendered by the server brings a newer first page.
    useEffect(() => {
        setLatest((current) => (sameList(current, initial.messages) ? current : initial.messages));
    }, [initial.messages]);

    useEffect(() => {
        if (!live) return;
        let stopped = false;
        const controller = new AbortController();
        const read = () => {
            void polls
                .sessionHistory({ sessionId }, controller.signal)
                .then((answer) => {
                    if (stopped || !answer?.messages) return;
                    const next = answer.messages;
                    const current = latestRef.current;
                    if (sameList(current, next)) return;
                    // Pages loaded upward stay only while the newest page still
                    // meets what was shown; more new messages than a page leave
                    // a gap, and a conversation with a hole in it is worse than
                    // one that starts later.
                    const meets =
                        current.length === 0 ||
                        !answer.older ||
                        next.some((one) => one.id === current.at(-1)!.id);
                    setLatest(next);
                    if (!meets) setEarlier([]);
                    if (!meets || earlierRef.current.length === 0) setOlder(answer.older === true);
                })
                // Kept as it was: the next read tries again.
                .catch(() => undefined);
        };
        read();
        const stop = pollWhileVisible(read, HISTORY_MS);
        return () => {
            stopped = true;
            controller.abort();
            stop();
        };
    }, [sessionId, live]);

    const messages = useMemo(() => {
        const ids = new Set(latest.map((one) => one.id));
        return [...earlier.filter((one) => !ids.has(one.id)), ...latest];
    }, [earlier, latest]);

    useEffect(() => {
        onUserBodies?.(
            new Set(messages.filter((one) => one.role === "user").map((one) => promptKey(one.body)))
        );
    }, [messages, onUserBodies]);

    const newest = latest.at(-1)?.id;
    useEffect(() => {
        bottom.current?.scrollIntoView({ block: "end" });
    }, [newest, pending.length]);

    const loadOlder = () => {
        const first = messages[0];
        if (!first || loadingOlder) return;
        setLoadingOlder(true);
        setOlderFailed(false);
        void polls
            .sessionHistory({ sessionId, before: first.id })
            .then((answer) => {
                if (!answer?.messages) {
                    setOlderFailed(true);
                    return;
                }
                setEarlier((held) => [...answer.messages!, ...held]);
                setOlder(answer.older === true);
            })
            .catch(() => setOlderFailed(true))
            .finally(() => setLoadingOlder(false));
    };

    const results = useMemo(() => {
        const byRef = new Map<string, HistoryMessage>();
        for (const one of messages) if (one.kind === "result" && one.ref) byRef.set(one.ref, one);
        return byRef;
    }, [messages]);
    const calls = useMemo(
        () => new Set(messages.filter((one) => one.kind === "tool" && one.ref).map((one) => one.ref)),
        [messages]
    );

    return (
        <div className="min-w-0 space-y-3">
            {older || loadingOlder ? (
                <div className="flex flex-col items-center gap-2">
                    {loadingOlder ? (
                        <div className="w-full space-y-2" aria-label={t("session.history.loadingOlder")}>
                            <Skeleton className="h-4 w-1/3" />
                            <Skeleton className="h-12 w-full" />
                            <Skeleton className="h-4 w-1/4" />
                        </div>
                    ) : (
                        <Button variant="ghost" size="sm" onClick={loadOlder}>
                            {t("session.history.loadOlder")}
                        </Button>
                    )}
                    {olderFailed ? (
                        <p className="text-xs text-danger">{t("session.history.olderFailed")}</p>
                    ) : null}
                </div>
            ) : null}

            {messages.length === 0 && pending.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("session.nothingSaid")}</p>
            ) : null}

            {messages.map((message) => {
                if (message.kind === "result" && message.ref && calls.has(message.ref)) return null;
                if (message.kind === "tool" || message.kind === "result")
                    return (
                        <ToolCall
                            key={message.id}
                            call={message.kind === "tool" ? message : null}
                            result={message.kind === "tool" ? (results.get(message.ref) ?? null) : message}
                        />
                    );
                if (message.kind === "marker")
                    return (
                        <p key={message.id} className="text-center text-xs text-muted-foreground">
                            {message.subject === "compacted"
                                ? t("session.history.markers.compacted")
                                : t("session.history.markers.interrupted")}
                        </p>
                    );
                return (
                    <div key={message.id} className="min-w-0 space-y-1">
                        <p className="text-xs uppercase tracking-wide text-muted-foreground">
                            {message.role === "user"
                                ? message.authorId
                                    ? t("session.you")
                                    : t("session.history.fromTerminal")
                                : message.role === "agent"
                                  ? t("sessions.form.agent")
                                  : "Polaris" /* i18n-ignore the product's name */}
                        </p>
                        {/* Only Polaris's own lines are its words to translate;
                            what a person or the agent said stays as said. */}
                        {message.role === "system" ? (
                            <p className="whitespace-pre-wrap break-words text-sm">
                                {agentText(t, message.body)}
                            </p>
                        ) : (
                            <MessageText text={message.body} />
                        )}
                    </div>
                );
            })}

            {/* Sent, not yet echoed back. Dimmed rather than marked as failing:
                nothing has gone wrong, the server has simply not been re-read. */}
            {pending.map((one) => (
                <div key={one.key} className="min-w-0 space-y-1 opacity-60">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                        {t("session.you")}
                    </p>
                    <p className="whitespace-pre-wrap break-words text-sm">{one.body}</p>
                </div>
            ))}
            <div ref={bottom} />
        </div>
    );
}

/** A fence's language, when it names one the highlighter could know. */
function fenceLanguage(info: string): string | null {
    const token = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return /^[a-z0-9+#-]{1,20}$/.test(token) ? token : null;
}

/** Text, with its fenced code blocks painted. */
export function messageParts(text: string): ({ code: false; text: string } | { code: true; text: string; language: string | null })[] {
    const parts: ({ code: false; text: string } | { code: true; text: string; language: string | null })[] = [];
    const fence = /```([^\n`]*)\n([\s\S]*?)(?:\n```|$)/g;
    let at = 0;
    for (let match = fence.exec(text); match; match = fence.exec(text)) {
        if (match.index > at) parts.push({ code: false, text: text.slice(at, match.index) });
        parts.push({ code: true, text: match[2]!, language: fenceLanguage(match[1]!) });
        at = fence.lastIndex;
    }
    if (at < text.length) parts.push({ code: false, text: text.slice(at) });
    return parts.filter((part) => part.code || part.text.trim());
}

function MessageText({ text }: { text: string }) {
    return (
        <div className="min-w-0 space-y-2 text-sm">
            {messageParts(text).map((part, index) =>
                part.code ? (
                    <div key={index} className="max-w-full overflow-x-auto rounded-md bg-muted">
                        <CodeSurface code={part.text} language={part.language} readOnly />
                    </div>
                ) : (
                    <p key={index} className="whitespace-pre-wrap break-words">
                        {part.text.trim()}
                    </p>
                )
            )}
        </div>
    );
}

/** A tool the agent ran, folded to one line, with what it answered inside. */
function ToolCall({ call, result }: { call: HistoryMessage | null; result: HistoryMessage | null }) {
    const t = useTranslations("agents");
    const failed = result?.subject === "error";
    const name = call?.subject ?? "";
    return (
        <details className="group min-w-0 rounded-md border border-border/60 text-xs">
            <summary className="flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1.5 text-muted-foreground">
                <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
                {failed ? (
                    <TriangleAlert className="size-3.5 shrink-0 text-danger" />
                ) : (
                    <Wrench className="size-3.5 shrink-0" />
                )}
                <span className="shrink-0 font-medium text-foreground">
                    {name ? t("session.history.tool", { name }) : t("session.history.result")}
                </span>
                {call?.body ? (
                    <span className="min-w-0 truncate font-mono" title={call.body}>
                        {call.body}
                    </span>
                ) : null}
            </summary>
            <div className="space-y-2 px-2 pb-2">
                {call?.body ? (
                    <div className="max-w-full overflow-x-auto rounded-md bg-muted">
                        <CodeSurface code={call.body} language={name === "Bash" ? "bash" : null} readOnly />
                    </div>
                ) : null}
                <p className="text-muted-foreground">
                    {failed ? t("session.history.resultError") : t("session.history.result")}
                </p>
                {result ? (
                    result.body ? (
                        <div className="max-h-72 max-w-full overflow-auto rounded-md bg-muted">
                            <CodeSurface code={result.body} language={null} readOnly />
                        </div>
                    ) : (
                        <p className="text-muted-foreground">{t("session.history.emptyResult")}</p>
                    )
                ) : (
                    <p className="text-muted-foreground">{t("session.history.noResult")}</p>
                )}
            </div>
        </details>
    );
}
