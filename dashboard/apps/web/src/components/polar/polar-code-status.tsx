"use client";

/**
 * The parts of a Code session's dock that follow what the session reports:
 * the status line under the reply box, the "/context" card, the messages
 * queued while the agent works, and the transcript download.
 */

import { useState } from "react";
import { saveFile } from "@/components/transfers/move-file";
import * as codeStatus from "@/lib/polar/code-status";
import type { PolarCodeThread } from "@/lib/polar/code";
import { Download, GitBranch, Pencil, X } from "lucide-react";
import { formatTokens, formatUsd } from "@/lib/polar/usage-format";
import type { TranscriptFormat } from "@/lib/polar/code-transcript";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
    Textarea
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

/** The messages typed while the agent works, each editable or taken back
 *  until the turn ends and the oldest is sent. */
export function CodeQueuedList({
    waiting,
    disabled,
    onEdit,
    onTakeBack
}: {
    waiting: PolarCodeThread["waiting"];
    disabled: boolean;
    onEdit: (id: string, text: string) => void;
    onTakeBack: (id: string) => void;
}) {
    const t = useTranslations("polar");
    const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
    if (waiting.length === 0) return null;
    return (
        <section aria-label={t("code.queue.title")} className="flex min-w-0 flex-col gap-1">
            <p className="px-1 text-xs text-muted-foreground">{t("code.queue.title")}</p>
            <ol className="flex min-w-0 flex-col gap-1">
                {waiting.map((item) => (
                    <li
                        key={item.id}
                        className="flex min-w-0 items-start gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm"
                    >
                        {editing?.id === item.id ? (
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <Textarea
                                    aria-label={t("code.queue.edit")}
                                    value={editing.text}
                                    maxLength={20_000}
                                    onChange={(event) => setEditing({ id: item.id, text: event.target.value })}
                                    rows={2}
                                />
                                <div className="flex flex-wrap justify-end gap-2">
                                    <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
                                        {t("code.queue.cancel")}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={
                                            disabled || !editing.text.trim() || editing.text.trim() === item.text
                                        }
                                        onClick={() => {
                                            onEdit(item.id, editing.text.trim());
                                            setEditing(null);
                                        }}
                                    >
                                        {t("code.queue.save")}
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <>
                                <p className="min-w-0 flex-1 whitespace-pre-wrap break-words line-clamp-3" title={item.text}>
                                    {item.text}
                                    {item.files > 0 ? (
                                        <span className="text-muted-foreground">
                                            {" "}
                                            {t("code.queue.files", { count: item.files })}
                                        </span>
                                    ) : null}
                                </p>
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => setEditing({ id: item.id, text: item.text })}
                                    aria-label={t("code.queue.edit")}
                                    title={t("code.queue.edit")}
                                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-11"
                                >
                                    <Pencil className="size-3.5" />
                                </button>
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onTakeBack(item.id)}
                                    aria-label={t("code.queue.remove")}
                                    title={t("code.queue.remove")}
                                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:size-11"
                                >
                                    <X className="size-4" />
                                </button>
                            </>
                        )}
                    </li>
                ))}
            </ol>
        </section>
    );
}

/** The session bar's download menu: the transcript as Markdown or JSONL. */
export function CodeExportMenu({ sessionId }: { sessionId: string }) {
    const t = useTranslations("polar");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={t("code.export.label")}
                    title={t("code.export.label")}
                    className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground [@media(pointer:coarse)]:size-11"
                >
                    <Download className="size-4" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => downloadTranscript(sessionId, "md", t("code.export.markdown"))}>
                    {t("code.export.markdown")}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadTranscript(sessionId, "jsonl", t("code.export.jsonl"))}>
                    {t("code.export.jsonl")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
