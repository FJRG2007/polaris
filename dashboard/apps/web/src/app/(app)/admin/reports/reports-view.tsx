"use client";

/**
 * The moderation queue.
 *
 * Rows rather than a table: every one of these is read, not scanned - what was
 * said, who said it, who objected and why - and a table would put the sentence
 * that matters in a column three across.
 *
 * Two buttons, because there are two answers. "Keep it" is a decision and is
 * recorded as one; a queue where the way to say no is to ignore the row is a
 * queue nobody can tell the state of. Removing goes through the same path a
 * moderator inside the conversation uses, so what is left behind is whatever the
 * instance's rules say - a tombstone, or nothing at all.
 *
 * The message text is the copy taken when it was reported. That is deliberate:
 * it is what was objected to, and reading the live message instead would show
 * something already edited.
 */

import Link from "next/link";
import { useState } from "react";
import { runAction } from "@/lib/run-action";
import { settleReportAction } from "./actions";
import { CHAT_REPORT_LABELS } from "@polaris/core";
import type { ChatReportView } from "@/lib/chat/reports";
import { useDisplayFormat } from "@/components/display-format";
import { VoiceNote } from "@/app/(app)/chat/voice-note";
import type { LinkPreviewView } from "@/lib/chat/link-preview";
import type { ChatReportFileView } from "@/lib/chat/report-files";
import { Check, Download, MessageSquare, Paperclip, Trash2 } from "lucide-react";
import { Badge, Button, Card, CardBody, Select } from "@polaris/ui";

const FILTERS = [
    { value: "open", label: "Waiting" },
    { value: "removed", label: "Removed" },
    { value: "kept", label: "Kept" },
    { value: "all", label: "Everything" }
] as const;

export function ReportsView({
    reports,
    status
}: {
    reports: readonly ChatReportView[];
    status: string;
}) {
    const format = useDisplayFormat();
    const [busy, setBusy] = useState("");
    const [error, setError] = useState("");

    const settle = async (id: string, decision: "kept" | "removed") => {
        setBusy(id);
        setError("");
        await runAction(() => settleReportAction(id, decision), setError);
        setBusy("");
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
                <Select
                    value={status}
                    onValueChange={(next) => {
                        // A plain navigation: the queue is a server-rendered
                        // list, and filtering it is asking for a different one.
                        window.location.search = `?status=${next}`;
                    }}
                    options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
                    aria-label="Which reports to show"
                    className="w-44"
                />
                <span className="text-xs text-muted-foreground">
                    {reports.length === 0
                        ? "Nothing here."
                        : `${reports.length} report${reports.length === 1 ? "" : "s"}`}
                </span>
            </div>

            {error && (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            )}

            {reports.map((report) => (
                <Card key={report.id}>
                    <CardBody className="flex flex-col gap-2 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge variant={report.status === "open" ? "primary" : "neutral"}>
                                {CHAT_REPORT_LABELS[report.reason]}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                                {report.channelName}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                reported by {report.reporterName}
                            </span>
                            <span className="ml-auto text-xs text-muted-foreground">
                                {format.dateTime(report.createdAt)}
                            </span>
                        </div>

                        {/* What was said, as it was when somebody objected to
                            it. Quoted rather than rendered: this is a moderation
                            surface, and a report is not a place to run somebody
                            else's formatting. */}
                        <blockquote className="whitespace-pre-wrap break-words border-l-2 border-border pl-3 text-sm">
                            {report.excerpt || (
                                <span className="text-muted-foreground">
                                    {report.files.length > 0 ? "No text - see below" : "No text"}
                                </span>
                            )}
                        </blockquote>

                        {/* What was actually attached. Most reports are about a
                            picture, and until this was here the queue showed the
                            words and not the thing anybody was objecting to. */}
                        <ReportFiles reportId={report.id} files={report.files} />

                        {/* The card the message drew, for a report about a link.
                            Drawn from what was already looked up: nothing here
                            visits an address somebody else chose. */}
                        {report.links.map((link) =>
                            link.view ? (
                                <ReportLink key={link.view.url} link={link.view} />
                            ) : null
                        )}

                        <p className="text-xs text-muted-foreground">
                            {report.authorName ? `Written by ${report.authorName}` : "Written by an account that is gone"}
                            {!report.live && " - the message is no longer there"}
                        </p>

                        {report.note && (
                            <p className="rounded-md bg-muted px-3 py-2 text-sm">{report.note}</p>
                        )}

                        <div className="flex flex-wrap items-center gap-2">
                            {report.status === "open" ? (
                                <>
                                    <Button
                                        size="sm"
                                        variant="danger"
                                        disabled={busy === report.id || !report.live}
                                        onClick={() => void settle(report.id, "removed")}
                                    >
                                        <Trash2 className="size-4" />
                                        Remove the message
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        disabled={busy === report.id}
                                        onClick={() => void settle(report.id, "kept")}
                                    >
                                        <Check className="size-4" />
                                        Keep it
                                    </Button>
                                </>
                            ) : (
                                <span className="text-xs text-muted-foreground">
                                    {report.status === "removed" ? "Removed" : "Kept"}
                                    {report.handledByName ? ` by ${report.handledByName}` : ""}
                                    {report.handledAt ? ` on ${format.dateTime(report.handledAt)}` : ""}
                                </span>
                            )}
                            {report.live && report.messageId && (
                                <Link
                                    href={`/chat/c/${report.channelId}/${report.messageId}`}
                                    className="ml-auto flex items-center gap-1 text-xs text-muted-foreground no-underline hover:text-foreground"
                                >
                                    <MessageSquare className="size-3.5" />
                                    Open it in the conversation
                                </Link>
                            )}
                        </div>
                    </CardBody>
                </Card>
            ))}
        </div>
    );
}

/**
 * What was attached to the message, as the moderator has to see it.
 *
 * Drawn rather than listed. A report of a picture where the picture is a
 * filename is a report nobody can answer without opening the conversation, which
 * for a direct message they cannot do at all - and being able to would be a
 * worse feature than this one.
 *
 * Served from the report's own route, which is gated on administering the
 * instance. That is the only reason these are readable here.
 */
function ReportFiles({
    reportId,
    files
}: {
    reportId: string;
    files: readonly ChatReportFileView[];
}) {
    if (files.length === 0) return null;

    const href = (file: ChatReportFileView) => `/api/chat/reports/${reportId}/files/${file.id}`;

    return (
        <div className="flex flex-col gap-2">
            {files.map((file) => (
                <div key={file.id} className="flex flex-col gap-1">
                    {file.contentType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                            src={href(file)}
                            alt={file.name}
                            className="max-h-72 w-auto max-w-full rounded-md border border-border object-contain"
                        />
                    ) : file.contentType.startsWith("video/") ? (
                        <video
                            src={href(file)}
                            controls
                            preload="metadata"
                            className="max-h-72 w-auto max-w-full rounded-md border border-border"
                        />
                    ) : file.contentType.startsWith("audio/") ? (
                        <VoiceNote
                            href={href(file)}
                            name={file.name}
                            recorded={false}
                            durationMs={file.durationMs}
                            waveform={file.waveform}
                        />
                    ) : (
                        <a
                            href={`${href(file)}?download=1`}
                            className="flex w-fit items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs no-underline hover:bg-muted"
                        >
                            <Paperclip className="size-3.5 shrink-0" />
                            <span className="min-w-0 truncate">{file.name}</span>
                            <Download className="size-3.5 shrink-0 text-muted-foreground" />
                        </a>
                    )}
                    <span className="text-[11px] text-foreground-subtle">
                        {file.name}
                        {/* Said out loud, because the two are different claims: a
                            live file is the one still on the message, and a kept
                            one is the copy that outlived it. */}
                        {file.held ? " - kept after the message was deleted" : null}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** The card the message drew for a link, for a report about one. */
function ReportLink({ link }: { link: LinkPreviewView }) {
    return (
        <a
            href={link.url}
            target="_blank"
            rel="noreferrer noopener nofollow"
            className="flex gap-3 rounded-md border border-border p-2.5 no-underline hover:bg-muted"
        >
            {link.hasImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={`/api/chat/links/${link.id}/image`}
                    alt=""
                    className="size-16 shrink-0 rounded object-cover"
                />
            ) : null}
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[11px] text-foreground-subtle">
                    {link.siteName || new URL(link.url).hostname}
                </span>
                <span className="truncate text-sm font-medium text-foreground">{link.title}</span>
                <span className="line-clamp-2 text-[12px] text-muted-foreground">
                    {link.description}
                </span>
            </span>
        </a>
    );
}
