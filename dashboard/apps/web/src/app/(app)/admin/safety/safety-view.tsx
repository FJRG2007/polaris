"use client";

/**
 * The safety queue, as one list.
 *
 * Cases about people first and messages under them, and that order is the whole
 * argument for the screen existing: an account that has locked itself down
 * believes somebody else is in it right now, and it must not be below eleven
 * arguments about a chat message.
 *
 * Rows rather than a table, for the reason the message queue has always used
 * them: every one of these is read rather than scanned, and a table puts the
 * sentence that matters in a column three across.
 */

import Link from "next/link";
import { useState } from "react";
import * as core from "@polaris/core";
import { runAction } from "@/lib/run-action";
import { settleSafetyCaseAction } from "./actions";
import { ReportsView } from "../reports/reports-view";
import type { ChatReportView } from "@/lib/chat/reports";
import type { SafetyCaseView } from "@/lib/safety-queue";
import { ShieldAlert, Flag, Check, X } from "lucide-react";
import { useDisplayFormat } from "@/components/display-format";
import { Badge, Button, Card, CardBody, Input, Select } from "@polaris/ui";

const FILTERS = [
    { value: "open", label: "Waiting" },
    { value: "resolved", label: "Resolved" },
    { value: "dismissed", label: "Dismissed" },
    { value: "all", label: "Everything" }
] as const;

export function SafetyView({
    cases,
    reports,
    status
}: {
    cases: readonly SafetyCaseView[];
    reports: readonly ChatReportView[];
    status: string;
}) {
    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">Accounts</h2>
                    <Select
                        value={status}
                        className="w-44"
                        aria-label="Which cases to show"
                        options={FILTERS.map((filter) => ({ ...filter }))}
                        onValueChange={(value) => {
                            window.location.href = `/admin/safety?status=${value}`;
                        }}
                    />
                </div>
                {cases.length === 0 ? (
                    <Card>
                        <CardBody className="py-8 text-center text-sm text-muted-foreground">
                            Nothing about an account is waiting.
                        </CardBody>
                    </Card>
                ) : (
                    <ul className="flex flex-col gap-2">
                        {cases.map((entry) => (
                            <li key={entry.id}>
                                <CaseCard entry={entry} />
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="flex flex-col gap-3">
                <h2 className="text-sm font-medium">Messages</h2>
                {/* The message queue, unchanged and still its own thing: what
                    "removed" means for a message is a decision with a message
                    behind it, and none of that applies to a person. */}
                <ReportsView reports={reports} status={status === "all" ? "all" : "open"} />
            </section>
        </div>
    );
}

function CaseCard({ entry }: { entry: SafetyCaseView }) {
    const format = useDisplayFormat();
    const [outcome, setOutcome] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lockdown = entry.kind === "lockdown";

    async function settle(next: "resolved" | "dismissed"): Promise<void> {
        setBusy(true);
        setError(null);
        await runAction(
            () => settleSafetyCaseAction({ caseId: entry.id, status: next, outcome }),
            setError
        );
        setBusy(false);
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start gap-3">
                    {lockdown ? (
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                    ) : (
                        <Flag className="mt-0.5 size-4 shrink-0 text-warning" />
                    )}
                    <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-1.5 text-sm">
                            <span className="font-medium">
                                {core.SAFETY_CASE_KIND_LABELS[entry.kind]}
                            </span>
                            <Link
                                href={`/admin/users?q=${encodeURIComponent(entry.subject.email)}`}
                                className="min-w-0 truncate text-muted-foreground"
                            >
                                {entry.subject.name} ({entry.subject.email})
                            </Link>
                            {lockdown ? (
                                <Badge variant={entry.stillLocked ? "danger" : "neutral"}>
                                    {entry.stillLocked ? "Still locked down" : "Lifted"}
                                </Badge>
                            ) : (
                                <Badge>
                                    {core.USER_REPORT_REASON_LABELS[
                                        entry.reason as core.UserReportReason
                                    ] ?? entry.reason}
                                </Badge>
                            )}
                            {entry.status !== "open" ? (
                                <Badge variant="neutral">
                                    {core.SAFETY_CASE_STATUS_LABELS[entry.status]}
                                </Badge>
                            ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {entry.reporter
                                ? `Reported by ${entry.reporter.name}`
                                : "Raised by the account itself"}{" "}
                            - {format.dateTime(entry.createdAt)}
                        </p>
                    </div>
                </div>

                {entry.note ? (
                    <p className="whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-sm">
                        {entry.note}
                    </p>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        {lockdown
                            ? "They said nothing about why."
                            : "The reporter added nothing."}
                    </p>
                )}

                {entry.status === "open" ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={outcome}
                            maxLength={core.MAX_REPORT_NOTE}
                            className="min-w-0 flex-1"
                            aria-label="What you found"
                            placeholder={
                                lockdown
                                    ? "What you found. The account owner is told this."
                                    : "What you decided. Kept as the record."
                            }
                            onChange={(event) => setOutcome(event.target.value)}
                        />
                        <Button size="sm" disabled={busy} onClick={() => void settle("resolved")}>
                            <Check className="size-3.5" />
                            Looked at it
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void settle("dismissed")}
                        >
                            <X className="size-3.5" />
                            Nothing to do
                        </Button>
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        {entry.handledBy ? `${entry.handledBy.name} settled it` : "Settled"}
                        {entry.handledAt ? ` on ${format.dateTime(entry.handledAt)}` : ""}
                        {entry.outcome ? `: ${entry.outcome}` : "."}
                    </p>
                )}

                {/* A lockdown is the owner's to lift, and deliberately so: an
                    administrator who could lift it could also lift the one raised
                    against them. Saying so here stops somebody looking for a
                    button that should not exist. */}
                {lockdown && entry.stillLocked ? (
                    <p className="text-xs text-muted-foreground">
                        Only they can lift the lockdown, from a device already signed in.
                    </p>
                ) : null}

                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
