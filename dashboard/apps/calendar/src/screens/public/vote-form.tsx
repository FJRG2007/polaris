"use client";

/**
 * A participant's ballot on a meeting proposal, opened from their own link:
 * yes, maybe or no for each candidate time, in their own time zone.
 */

import { useState } from "react";
import { browserZone } from "../time";
import { useCalendarT } from "../i18n";
import { hostUi } from "@polaris/app-host/client";
import { Button, SegmentedControl } from "@polaris/ui";
import type { Vote } from "../../lib/scheduling-schemas";
import * as proposalActions from "../../actions/proposals";
import { formatRange, PublicFrame, StatusNote } from "./kit";
import type { VotePageView } from "../../lib/scheduling-wire";

export function VoteForm({ token, view }: { token: string; view: VotePageView }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const zone = browserZone();
    const [votes, setVotes] = useState<Record<string, Vote>>({ ...view.votes });
    const [saved, setSaved] = useState<Record<string, Vote>>({ ...view.votes });
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const dirty = JSON.stringify(votes) !== JSON.stringify(saved);
    const closed = view.status === "closed";

    const submit = async () => {
        if (busy || !dirty) return;
        setBusy(true);
        setProblem(null);
        setDone(false);
        const answer = await hostUi.runAction.runAction(
            () => proposalActions.castVotesAction({ token, votes }),
            setProblem
        );
        setBusy(false);
        if (!answer) return;
        if (!answer.ok) {
            setProblem(answer.error);
            return;
        }
        setSaved(votes);
        setDone(true);
    };

    const end = (start: string) =>
        new Date(Date.parse(start) + view.durationMinutes * 60_000).toISOString();

    return (
        <PublicFrame
            title={view.title}
            subtitle={
                <span>
                    {t("vote.askedBy", { name: view.organizer })}
                    {view.location ? `, ${view.location}` : ""}
                </span>
            }
        >
            {view.description ? (
                <p className="whitespace-pre-wrap text-[13px] text-muted-foreground">
                    {view.description}
                </p>
            ) : null}
            {closed ? (
                <StatusNote tone="neutral">
                    {view.chosen
                        ? t("vote.closedChosen", {
                              when: formatRange(view.chosen, end(view.chosen), zone, locale)
                          })
                        : t("vote.closed")}
                </StatusNote>
            ) : (
                <p className="text-[13px] text-muted-foreground">{t("vote.intro", { zone })}</p>
            )}
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                {view.dates.map((date) => (
                    <li
                        key={date.id}
                        className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <span className="text-[13px]">
                            {formatRange(date.start, end(date.start), zone, locale)}
                        </span>
                        <SegmentedControl
                            size="sm"
                            aria-label={t("vote.choiceFor", {
                                when: formatRange(date.start, end(date.start), zone, locale)
                            })}
                            value={votes[date.id] ?? ("" as Vote)}
                            onValueChange={(value) =>
                                !closed && setVotes((current) => ({ ...current, [date.id]: value }))
                            }
                            options={[
                                { value: "yes", label: t("vote.yes"), disabled: closed },
                                { value: "maybe", label: t("vote.maybe"), disabled: closed },
                                { value: "no", label: t("vote.no"), disabled: closed }
                            ]}
                        />
                    </li>
                ))}
            </ul>
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {done && !dirty ? <StatusNote tone="success">{t("vote.saved")}</StatusNote> : null}
            {closed ? null : (
                <div className="flex justify-end">
                    <Button
                        onClick={() => void submit()}
                        disabled={busy}
                        aria-disabled={!dirty || busy}
                    >
                        {t("vote.submit")}
                    </Button>
                </div>
            )}
        </PublicFrame>
    );
}
