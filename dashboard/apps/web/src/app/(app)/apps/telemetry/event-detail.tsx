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
import { Cpu, Eye, EyeOff, Globe, Monitor, Server, Smartphone } from "lucide-react";
import type { EventDetail } from "@/lib/telemetry/report-service";
import type { ContextGroup, HeaderField, StackFrame } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { JsonView, isValidJson } from "@/components/json-view";
import { useHighlighter } from "@/lib/code-highlight";
import { languageForFile } from "@/lib/code-language";
import { environmentOf, type EnvironmentFact } from "@/lib/telemetry/environment";
import { PlatformMarkIcon } from "./platform-marks";

/** The grammar a frame's file is written in, by its name past any query. */
function frameLanguage(file: string): string | null {
    const name = file.split(/[?#]/)[0]?.split(/[\\/]/).pop() ?? "";
    return languageForFile(name)?.id ?? null;
}

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
        <div className="flex flex-col gap-0.5 px-3 py-1.5 text-xs sm:flex-row sm:items-baseline sm:gap-3">
            <span className="truncate text-muted-foreground sm:w-44 sm:shrink-0" title={name}>
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
    const t = useTranslations("telemetry");
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
                aria-label={shown ? t("event.hide") : t("event.show")}
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

/** One source line, painted when its grammar has loaded. */
function Line({ line, painted }: { line: string; painted: string | null }) {
    // highlight.js escapes what it is given; the only markup is its own spans.
    if (painted === null) return <span className="whitespace-pre">{line}</span>;
    return <span className="whitespace-pre" dangerouslySetInnerHTML={{ __html: painted }} />;
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
    // Painted a line at a time: the rows carry their own numbers and the marked
    // line, and a snippet is a few lines cut out of a file anyway.
    const language = snippet ? frameLanguage(frame.file) : null;
    const highlight = useHighlighter(language);
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
                <span className="min-w-0 break-all" title={frame.file}>
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
                            <Line
                                line={row.line}
                                painted={
                                    language && highlight ? highlight(row.line, language) : null
                                }
                            />
                        </div>
                    ))}
                </pre>
            )}
        </li>
    );
}

/** The glyph for a fact with no logo of its own: a runtime nobody here has a
 *  mark for, a system that is none of the known ones, the device itself. */
function FallbackIcon({ fact, server }: { fact: EnvironmentFact; server: boolean }) {
    const className = "size-4 text-muted-foreground";
    if (fact.kind === "runtime") return <Cpu className={className} aria-hidden="true" />;
    if (fact.kind === "browser") return <Globe className={className} aria-hidden="true" />;
    if (fact.mobile) return <Smartphone className={className} aria-hidden="true" />;
    if (fact.kind === "device" && server) return <Server className={className} aria-hidden="true" />;
    return <Monitor className={className} aria-hidden="true" />;
}

/**
 * Runtime, system, browser and device at a glance, each with its mark - the
 * strip Sentry draws above an event, because "only on Alpine" or "only in
 * Safari" is the answer to most reports. The full groups stay further down.
 */
function EnvironmentStrip({ facts }: { facts: readonly EnvironmentFact[] }) {
    const t = useTranslations("telemetry");
    // A device beside a server runtime and no browser is a server.
    const server = !facts.some((fact) => fact.kind === "browser");
    return (
        <ul
            aria-label={t("event.environment")}
            className="grid grid-cols-1 gap-2 min-[30rem]:grid-cols-2 xl:grid-cols-4"
        >
            {facts.map((fact) => {
                const said = fact.version ? `${fact.name} ${fact.version}` : fact.name;
                const detail =
                    fact.detail === null
                        ? null
                        : fact.kind === "os"
                          ? t("event.kernel", { version: fact.detail })
                          : fact.detail;
                return (
                    <li
                        key={fact.kind}
                        className="flex min-w-0 items-center gap-2.5 rounded-lg border border-border bg-surface px-3 py-2"
                    >
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
                            {fact.mark ? (
                                <PlatformMarkIcon mark={fact.mark} className="size-[1.125rem]" />
                            ) : (
                                <FallbackIcon fact={fact} server={server} />
                            )}
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-[0.6875rem] text-muted-foreground">
                                {t(`event.facts.${fact.kind}`)}
                            </span>
                            <span className="truncate text-sm font-medium" title={said}>
                                {fact.name}
                                {fact.version && (
                                    <span className="font-normal text-muted-foreground">
                                        {" "}
                                        {fact.version}
                                    </span>
                                )}
                            </span>
                            {detail && (
                                <span
                                    className="truncate font-mono text-[0.6875rem] text-muted-foreground"
                                    title={detail}
                                >
                                    {detail}
                                </span>
                            )}
                        </span>
                    </li>
                );
            })}
        </ul>
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
    const t = useTranslations("telemetry");
    const tags = Object.entries(event.tags);
    const request = event.request;
    const body = request?.body ?? null;
    const facts = environmentOf(event.contexts, event.tags);
    return (
        <div className="flex flex-col gap-4">
            {facts.length > 0 && <EnvironmentStrip facts={facts} />}

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{t("event.mostRecent", { count: kept })}</span>
                {event.serverName && <span>{t("event.on", { server: event.serverName })}</span>}
                {event.ip && <span>{t("event.from", { ip: event.ip })}</span>}
                {event.userLabel && <span>{t("event.for", { user: event.userLabel })}</span>}
                {event.sdk && (
                    <span>
                        {t("event.via", {
                            sdk: event.sdk.version
                                ? `${event.sdk.name} ${event.sdk.version}`
                                : event.sdk.name
                        })}
                    </span>
                )}
            </div>

            {event.frames.length > 0 && (
                <Panel title={t("event.stack")}>
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
                            : t("event.request")
                    }
                >
                    {request.query.length > 0 && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                {t("event.query")}
                            </p>
                            <Fields fields={request.query} />
                        </>
                    )}
                    {request.headers.length > 0 && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                {t("event.headers")}
                            </p>
                            <Fields fields={request.headers} />
                        </>
                    )}
                    {body && (
                        <>
                            <p className="bg-muted/40 px-3 py-1 text-xs text-muted-foreground">
                                {t("event.body")}
                            </p>
                            {/* A JSON body is painted; a form or text body has no
                                grammar to paint and stays as it came. */}
                            {isValidJson(body) ? (
                                <JsonView
                                    value={body}
                                    label={t("event.body")}
                                    className="m-2 max-h-96"
                                />
                            ) : (
                                <pre className="overflow-x-auto px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
                                    {body}
                                </pre>
                            )}
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
                <Panel title={t("event.before")}>
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
