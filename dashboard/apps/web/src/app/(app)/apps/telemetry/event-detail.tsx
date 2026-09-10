"use client";

/**
 * One occurrence, in full.
 *
 * A crash report that is a message and a stack is a report somebody has to go
 * and reproduce. Everything that saves them the trip is already in what a Sentry
 * client sends and was being thrown away on the way in: which runtime, which
 * machine, how much memory was left, what the request was, and - the one that
 * changes the most - the lines of source around the one that threw.
 *
 * So this screen is the shape of that envelope rather than a summary of it. The
 * order is the order somebody reads in: what threw, the code it threw in, the
 * request that was in flight, what happened just before, and last the facts
 * about the machine, which are what you check when the first four did not
 * explain it.
 *
 * Its own file because the list screen is already long and this is the half that
 * grows every time a client starts sending something new.
 */

import { useState } from "react";
import { cn, Button } from "@polaris/ui";
import { Eye, EyeOff } from "lucide-react";
import type { EventDetail } from "@/lib/telemetry/report-service";
import type { ContextGroup, HeaderField, StackFrame } from "@polaris/core";

/** A titled box. Every section on this screen is one, so the screen reads as a
 *  list of answers rather than as a wall. */
function Panel({ title, children }: { title: string; children: React.ReactNode }) {
    return (
        <div className="overflow-hidden rounded-lg border border-border">
            <p className="border-b border-border bg-surface px-3 py-1.5 text-xs font-medium">
                {title}
            </p>
            {children}
        </div>
    );
}

/** Name on the left, value on the right, both selectable. The value is the thing
 *  somebody came for, so it gets the width. */
function Pair({ name, children }: { name: string; children: React.ReactNode }) {
    return (
        <div className="flex items-baseline gap-3 px-3 py-1.5 text-xs">
            <span className="w-44 shrink-0 truncate text-muted-foreground" title={name}>
                {name}
            </span>
            <span className="min-w-0 flex-1 break-all font-mono">{children}</span>
        </div>
    );
}

/**
 * A value that is a credential, covered until somebody asks for it.
 *
 * Kept rather than blanked at the ingest, because a request that failed on a bad
 * token is a request whose token is the answer. Covered here, because the same
 * screen is shared, screenshotted and pasted into a conversation, and a bearer
 * token that is live at the moment it is read out of a bug report is a much
 * worse day than the one being debugged.
 *
 * Which names count is decided once, in `headerIsSecret`, and the ingest marks
 * them - so this component asks no questions and simply draws what it was told.
 */
function Secret({ value }: { value: string }) {
    const [shown, setShown] = useState(false);
    return (
        <span className="flex items-baseline gap-2">
            <span
                className={cn("min-w-0 flex-1 break-all", !shown && "select-none tracking-widest")}
            >
                {shown ? value : "•".repeat(Math.min(24, Math.max(8, value.length)))}
            </span>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0"
                aria-label={shown ? "Hide this value" : "Show this value"}
                onClick={() => setShown((was) => !was)}
            >
                {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </Button>
        </span>
    );
}

function Fields({ fields }: { fields: readonly HeaderField[] }) {
    return (
        <div className="divide-y divide-border">
            {fields.map((field, at) => (
                <Pair key={`${field.name}:${at}`} name={field.name}>
                    {field.secret ? <Secret value={field.value} /> : field.value}
                </Pair>
            ))}
        </div>
    );
}

/**
 * One frame, and the code it was on when it is known.
 *
 * The application's own frames are open and everybody else's are closed: a stack
 * is mostly library, and the three lines worth reading are the ones in code
 * somebody here can change. A frame with no snippet draws exactly as it did
 * before - most clients send none, and a row that grew an empty box would be
 * worse than the row that said nothing.
 */
function Frame({ frame }: { frame: StackFrame }) {
    const snippet = frame.pre.length > 0 || frame.post.length > 0 || frame.context !== null;
    const first = (frame.line ?? frame.pre.length + 1) - frame.pre.length;
    return (
        <li
            className={cn(
                "px-3 py-1.5 font-mono text-xs",
                frame.inApp ? "bg-transparent" : "bg-muted/40 text-muted-foreground"
            )}
        >
            <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{frame.function || "<anonymous>"}</span>
                <span className="min-w-0 truncate" title={frame.file}>
                    {frame.file}
                </span>
                {frame.line !== null && (
                    <span className="text-muted-foreground">:{frame.line}</span>
                )}
            </div>
            {snippet && (
                <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/60 py-1 text-[0.6875rem] leading-relaxed">
                    {[
                        ...frame.pre.map((line, at) => ({ line, at: first + at, threw: false })),
                        ...(frame.context === null
                            ? []
                            : [
                                  {
                                      line: frame.context,
                                      at: frame.line ?? first + frame.pre.length,
                                      threw: true
                                  }
                              ]),
                        ...frame.post.map((line, at) => ({
                            line,
                            at: (frame.line ?? first + frame.pre.length) + at + 1,
                            threw: false
                        }))
                    ].map((row, at) => (
                        <div
                            key={at}
                            className={cn(
                                "flex gap-3 px-2",
                                // The line that threw, marked rather than only
                                // centred: a snippet scrolled sideways loses the
                                // middle, and this is the row it was opened for.
                                row.threw && "bg-danger-soft font-medium text-foreground"
                            )}
                        >
                            <span className="w-10 shrink-0 select-none text-right text-muted-foreground">
                                {row.at}
                            </span>
                            <span className="whitespace-pre">{row.line}</span>
                        </div>
                    ))}
                </pre>
            )}
        </li>
    );
}

/** The machine, the runtime, the browser - whatever the client chose to send. */
function Contexts({ groups }: { groups: readonly ContextGroup[] }) {
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {groups.map((group) => (
                <Panel key={group.name} title={humanize(group.name)}>
                    <div className="divide-y divide-border">
                        {group.fields.map((field) => (
                            <Pair key={field.key} name={humanize(field.key)}>
                                {sized(field.key, field.value)}
                            </Pair>
                        ))}
                    </div>
                </Panel>
            ))}
        </div>
    );
}

/** `processor_count` is not a label. Underscores out, first letter up, and
 *  nothing else - a translation table would be a list to keep in step with
 *  whatever clients decide to send next. */
function humanize(key: string): string {
    const said = key.replace(/[_.-]+/g, " ").trim();
    return said.charAt(0).toUpperCase() + said.slice(1);
}

/** Bytes as bytes are worth reading. 8323719168 is a number nobody converts in
 *  their head, and "7.8 GB" is the fact it was sent for. */
function sized(key: string, value: string): string {
    if (!/memory|size|bytes/i.test(key)) return value;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 1024) return value;
    const units = ["KB", "MB", "GB", "TB"];
    let at = -1;
    let left = bytes;
    while (left >= 1024 && at < units.length - 1) {
        left /= 1024;
        at += 1;
    }
    return `${left.toFixed(1)} ${units[at]}`;
}

/** The occurrence itself: what threw, where, and everything around it. */
export function EventPanel({ event, kept }: { event: EventDetail; kept: number }) {
    const tags = Object.entries(event.tags);
    const request = event.request;
    const body = request?.body ?? null;
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                    Most recent of {kept === 1 ? "one kept occurrence" : `${kept} kept occurrences`}
                </span>
                {event.serverName && <span>on {event.serverName}</span>}
                {event.ip && <span>from {event.ip}</span>}
                {event.userLabel && <span>for {event.userLabel}</span>}
                {event.sdk && (
                    <span>
                        via {event.sdk.name}
                        {event.sdk.version ? ` ${event.sdk.version}` : ""}
                    </span>
                )}
            </div>

            {event.frames.length > 0 && (
                <Panel title="Stack">
                    {/* Innermost last, which is the order every client sends and
                        every debugger prints. */}
                    <ol className="divide-y divide-border">
                        {event.frames.map((frame, at) => (
                            <Frame key={`${frame.file}:${frame.line}:${at}`} frame={frame} />
                        ))}
                    </ol>
                </Panel>
            )}

            {request && (
                <Panel
                    title={
                        request.method && request.url
                            ? `${request.method} ${request.url}`
                            : "The request"
                    }
                >
                    {request.query.length > 0 && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                Query
                            </p>
                            <Fields fields={request.query} />
                        </>
                    )}
                    {request.headers.length > 0 && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                Headers
                            </p>
                            <Fields fields={request.headers} />
                        </>
                    )}
                    {body && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                Body
                            </p>
                            <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
                                {body}
                            </pre>
                        </>
                    )}
                </Panel>
            )}

            {tags.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {tags.map(([name, value]) => (
                        <span
                            key={name}
                            className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground"
                        >
                            {name}: <span className="text-foreground">{value}</span>
                        </span>
                    ))}
                </div>
            )}

            {event.breadcrumbs.length > 0 && (
                <Panel title="What happened before it">
                    <ol className="divide-y divide-border">
                        {event.breadcrumbs.map((crumb, at) => (
                            <li key={`${crumb.at ?? at}:${at}`} className="px-3 py-1.5 text-xs">
                                <div className="flex items-baseline gap-2">
                                    <span className="w-20 shrink-0 truncate text-muted-foreground">
                                        {crumb.category || crumb.type}
                                    </span>
                                    <span
                                        className="min-w-0 flex-1 break-words"
                                        title={crumb.message}
                                    >
                                        {crumb.message}
                                    </span>
                                </div>
                                {crumb.data.length > 0 && (
                                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 pl-[5.5rem] font-mono text-[0.6875rem] text-muted-foreground">
                                        {crumb.data.map((field) => (
                                            <span key={field.key} className="break-all">
                                                {field.key}:{" "}
                                                <span className="text-foreground">
                                                    {field.value}
                                                </span>
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </li>
                        ))}
                    </ol>
                </Panel>
            )}

            {event.contexts.length > 0 && <Contexts groups={event.contexts} />}
        </div>
    );
}
