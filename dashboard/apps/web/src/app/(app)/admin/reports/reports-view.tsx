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
import { Check, MessageSquare, Trash2 } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
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
                            {report.excerpt || <span className="text-muted-foreground">No text</span>}
                        </blockquote>
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
