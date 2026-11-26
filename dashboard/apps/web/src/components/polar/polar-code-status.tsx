"use client";

/**
 * The parts of a Code session's dock that follow what the session reports:
 * the status line under the reply box, the "/context" card, the messages
 * queued while the agent works, and the transcript download.
 */

import { saveFile } from "@/components/transfers/move-file";
import * as codeStatus from "@/lib/polar/code-status";
import type { PolarCodeThread } from "@/lib/polar/code";
import { QueueItem } from "@/components/polar/elements/queue";
import { Download, GitBranch, Keyboard, MoreHorizontal, X } from "lucide-react";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import type { TranscriptFormat } from "@/lib/polar/code-transcript";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";

/** Where a session's transcript downloads from, in a format. */
export function transcriptHref(sessionId: string, format: TranscriptFormat): string {
    return `/api/polar/code/transcript?${new URLSearchParams({ sessionId, format }).toString()}`;
}

/** Start the download of a transcript, for "/export" and the menu: through the
 *  shared download, so the reader is told when it has started. */
export function downloadTranscript(sessionId: string, format: TranscriptFormat, label: string): void {
    saveFile(transcriptHref(sessionId, format), label);
}

/** The compact line under the reply box: model, effort, context, cost, branch. */
export function CodeStatusLine({ parts }: { parts: readonly codeStatus.CodeStatusPart[] }) {
    const t = useTranslations("polar");
    const locale = useLocale();
    if (parts.length === 0) return null;
    return (
        <div
            role="status"
            aria-label={t("code.status.label")}
            className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-xs text-muted-foreground"
        >
            {parts.map((part) => (
                <span key={part.kind} className="flex min-w-0 max-w-full items-center gap-1">
                    {part.kind === "branch" ? <GitBranch className="size-3 shrink-0" aria-hidden /> : null}
                    <span className="min-w-0 truncate" title={statusText(part)}>
                        {statusText(part)}
                    </span>
                </span>
            ))}
        </div>
    );

    function statusText(part: codeStatus.CodeStatusPart): string {
        switch (part.kind) {
            case "model":
            case "branch":
                return part.value;
            case "effort":
                return t("code.status.effort", { effort: part.value });
            case "context":
                return t("code.status.context", { percent: part.percent });
            case "cost":
                return formatUsd(part.usd, locale);
        }
    }
}

/** What "/context" shows: how full the window is and what fills it, as the
 *  agent's last turn reported it. */
export function CodeContextCard({
    context,
    model,
    onClose
}: {
    context: PolarCodeThread["context"];
    model: string | null;
    onClose: () => void;
}) {
    const t = useTranslations("polar");
    const locale = useLocale();
    const parts = context?.parts ?? null;
    const rows: [string, number][] = parts
        ? [
              [t("code.context.input"), parts.input],
              [t("code.context.cacheRead"), parts.cacheRead],
              [t("code.context.cacheWrite"), parts.cacheWrite],
              [t("code.context.output"), parts.output]
          ]
        : [];
    return (
        <section
            aria-label={t("code.context.title")}
            className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-3 text-sm"
        >
            <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 className="min-w-0 truncate font-medium">
                    {t("code.context.title")}
                    {model ? <span className="text-muted-foreground"> - {codeStatus.shownModel(model)}</span> : null}
                </h3>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t("code.context.close")}
                    title={t("code.context.close")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                >
                    <X className="size-4" />
                </button>
            </div>
            {context ? (
                <>
                    <p>
                        {t("code.context.used", {
                            used: formatTokens(context.used, locale),
                            window: formatTokens(context.window, locale),
                            percent: codeStatus.contextPercent(context.used, context.window)
                        })}
                    </p>
                    <div
                        className="h-1.5 overflow-hidden rounded-full bg-muted"
                        role="meter"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={codeStatus.contextPercent(context.used, context.window)}
                        aria-label={t("code.context.title")}
                    >
                        <div
                            className="h-full bg-primary"
                            style={{ width: `${codeStatus.contextPercent(context.used, context.window)}%` }}
                        />
                    </div>
                    {rows.length > 0 ? (
                        <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 text-xs">
                            {rows.map(([label, value]) => (
                                <div key={label} className="contents">
                                    <dt className="min-w-0 truncate text-muted-foreground" title={label}>{label}</dt>
                                    <dd className="text-end tabular-nums">{formatTokens(value, locale)}</dd>
                                </div>
                            ))}
                        </dl>
                    ) : null}
                    <p className="text-xs text-muted-foreground">{t("code.context.note")}</p>
                </>
            ) : (
                <p className="text-muted-foreground">{t("code.context.none")}</p>
            )}
        </section>
    );
}

/** The messages typed while the agent works, each editable, movable, sent
 *  now or taken back from one "..." menu per row (as Chat's queue), until the
 *  turn ends and the oldest is sent. "Send now" goes into the running turn
 *  where it `steers`, else the turn stops and it goes next. `onStopAll` stops
 *  the turn and sends none of them. */
export function CodeQueuedList({
    waiting,
    steers,
    disabled,
    onEdit,
    onTakeBack,
    onMove,
    onSendNow,
    onStopAll
}: {
    waiting: PolarCodeThread["waiting"];
    steers: boolean;
    disabled: boolean;
    onEdit: (id: string, text: string) => void;
    onTakeBack: (id: string) => void;
    onMove: (id: string, direction: "up" | "down") => void;
    /** Null where nobody may steer the session. */
    onSendNow: ((id: string) => void) | null;
    /** Null while the agent is not mid-turn. */
    onStopAll: (() => void) | null;
}) {
    const t = useTranslations("polar");
    if (waiting.length === 0) return null;
    return (
        <section aria-label={t("code.queue.title")} className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2 px-1">
                <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t("code.queue.title")}</p>
                {onStopAll ? (
                    <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onStopAll}>
                        {t("code.queue.stopAll")}
                    </Button>
                ) : null}
            </div>
            <ol className="flex min-w-0 flex-col gap-1">
                {waiting.map((item, index) => (
                    <QueueItem
                        key={item.id}
                        value={item.text}
                        labels={{
                            menu: t("queue.menu"),
                            sendNow: steers ? t("code.queue.steerNow") : t("code.queue.sendNow"),
                            edit: t("code.queue.edit"),
                            up: t("code.queue.up"),
                            down: t("code.queue.down"),
                            remove: t("code.queue.remove"),
                            save: t("code.queue.save"),
                            cancel: t("code.queue.cancel"),
                            files: item.files > 0 ? t("code.queue.files", { count: item.files }) : null
                        }}
                        first={index === 0}
                        last={index === waiting.length - 1}
                        disabled={disabled}
                        onSave={(text) => {
                            if (text.trim()) onEdit(item.id, text.trim());
                        }}
                        onSendNow={onSendNow ? () => onSendNow(item.id) : null}
                        onUp={() => onMove(item.id, "up")}
                        onDown={() => onMove(item.id, "down")}
                        onRemove={() => onTakeBack(item.id)}
                    />
                ))}
            </ol>
        </section>
    );
}

/** The session bar's "..." menu: what a session is rarely asked for - its
 *  transcript as Markdown or JSONL, and the keyboard shortcuts - kept out of
 *  the bar so only what most turns use stays in sight. */
export function CodeSessionMenu({ sessionId, onKeysHelp }: { sessionId: string; onKeysHelp: () => void }) {
    const t = useTranslations("polar");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={t("code.menu")}
                    title={t("code.menu")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                >
                    <MoreHorizontal className="size-4" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
                <DropdownMenuItem onSelect={() => downloadTranscript(sessionId, "md", t("code.export.markdown"))}>
                    <Download />
                    {t("code.export.asMarkdown")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadTranscript(sessionId, "jsonl", t("code.export.jsonl"))}>
                    <Download />
                    {t("code.export.asJsonl")}
                </DropdownMenuItem>
                <DropdownMenuItem className="max-md:hidden" onSelect={onKeysHelp}>
                    <Keyboard />
                    {t("code.keys.shortcuts")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
