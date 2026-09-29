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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, Input, Select } from "@polaris/ui";

const FILTERS = ["open", "resolved", "dismissed", "all"] as const;

export function SafetyView({
    cases,
    reports,
    status
}: {
    cases: readonly SafetyCaseView[];
    reports: readonly ChatReportView[];
    status: string;
}) {
    const t = useTranslations("admin");
    return (
        <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h2 className="text-sm font-medium">{t("safety.accounts")}</h2>
                    <Select
                        value={status}
                        className="w-44"
                        aria-label={t("safety.filters.label")}
                        options={FILTERS.map((filter) => ({
                            value: filter,
                            label: t(`safety.filters.${filter}`)
                        }))}
                        onValueChange={(value) => {
                            window.location.href = `/admin/safety?status=${value}`;
                        }}
                    />
                </div>
                {cases.length === 0 ? (
                    <Card>
                        <CardBody className="py-8 text-center text-sm text-muted-foreground">
                            {t("safety.empty")}
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
                <h2 className="text-sm font-medium">{t("safety.messages")}</h2>
                {/* The message queue, unchanged and still its own thing: what
                    "removed" means for a message is a decision with a message
                    behind it, and none of that applies to a person. */}
                <ReportsView reports={reports} status={status === "all" ? "all" : "open"} />
            </section>
        </div>
    );
}

function CaseCard({ entry }: { entry: SafetyCaseView }) {
    const t = useTranslations("admin");
    const format = useDisplayFormat();
    const [outcome, setOutcome] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const lockdown = entry.kind === "lockdown";
    // A reason the catalog does not know (one retired from the list) is shown
    // as it was stored.
    const reasonKey = `safety.reasons.${entry.reason}`;

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
                                {t(`safety.kinds.${entry.kind}`)}
                            </span>
                            <Link
                                href={`/admin/users?q=${encodeURIComponent(entry.subject.email)}`}
                                className="min-w-0 truncate text-muted-foreground"
                            >
                                {entry.subject.name} ({entry.subject.email})
                            </Link>
                            {lockdown ? (
                                <Badge variant={entry.stillLocked ? "danger" : "neutral"}>
                                    {entry.stillLocked ? t("safety.case.stillLocked") : t("safety.case.lifted")}
                                </Badge>
                            ) : (
                                <Badge>
                                    {t.has(reasonKey) ? t(reasonKey) : entry.reason}
                                </Badge>
                            )}
                            {entry.status !== "open" ? (
                                <Badge variant="neutral">
                                    {t(`safety.statuses.${entry.status}`)}
                                </Badge>
                            ) : null}
                        </p>
                        <p className="text-xs text-muted-foreground">
                            {entry.reporter
                                ? t("safety.case.reportedBy", {
                                      name: entry.reporter.name,
                                      time: format.dateTime(entry.createdAt)
                                  })
                                : t("safety.case.raisedBySelf", {
                                      time: format.dateTime(entry.createdAt)
                                  })}
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
                            ? t("safety.case.noNoteLockdown")
                            : t("safety.case.noNoteReport")}
                    </p>
                )}

                {entry.status === "open" ? (
                    <div className="flex flex-wrap items-center gap-2">
                        <Input
                            value={outcome}
                            maxLength={core.MAX_REPORT_NOTE}
                            className="min-w-0 flex-1"
                            aria-label={t("safety.case.outcomeLabel")}
                            placeholder={
                                lockdown
                                    ? t("safety.case.outcomeLockdown")
                                    : t("safety.case.outcomeReport")
                            }
                            onChange={(event) => setOutcome(event.target.value)}
                        />
                        <Button size="sm" disabled={busy} onClick={() => void settle("resolved")}>
                            <Check className="size-3.5" />
                            {t("safety.case.resolve")}
                        </Button>
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={busy}
                            onClick={() => void settle("dismissed")}
                        >
                            <X className="size-3.5" />
                            {t("safety.case.dismiss")}
                        </Button>
                    </div>
                ) : (
                    <p className="text-xs text-muted-foreground">
                        {t("safety.case.settled", {
                            who: entry.handledBy ? "named" : "nobody",
                            name: entry.handledBy?.name ?? "",
                            when: entry.handledAt ? "yes" : "no",
                            time: entry.handledAt ? format.dateTime(entry.handledAt) : "",
                            outcome: entry.outcome ? "yes" : "no",
                            text: entry.outcome ?? ""
                        })}
                    </p>
                )}

                {/* A lockdown is the owner's to lift, and deliberately so: an
                    administrator who could lift it could also lift the one raised
                    against them. Saying so here stops somebody looking for a
                    button that should not exist. */}
                {lockdown && entry.stillLocked ? (
                    <p className="text-xs text-muted-foreground">
                        {t("safety.case.ownerLifts")}
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
