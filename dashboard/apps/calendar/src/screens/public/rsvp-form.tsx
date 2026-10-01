"use client";

/**
 * Answering an invitation from its link: the event in the reader's own time
 * zone, and three buttons. For a series, the answer can be for all of it or
 * for one date.
 */

import { useState } from "react";
import { Linkified } from "../ui";
import { browserZone } from "../time";
import { useCalendarT } from "../i18n";
import { Button, Select } from "@polaris/ui";
import { hostUi } from "@polaris/app-host/client";
import * as rsvpActions from "../../actions/rsvp";
import type { RsvpView } from "../../lib/scheduling-wire";
import { formatRange, PublicFrame, StatusNote } from "./kit";
import { Check, CircleHelp, MapPin, Video, X } from "lucide-react";

type Answer = "ACCEPTED" | "TENTATIVE" | "DECLINED";

const SERIES = "series";

export function RsvpForm({ token, view, address }: { token: string; view: RsvpView; address: string }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const zone = browserZone();
    const [scope, setScope] = useState<string>(SERIES);
    const [answer, setAnswer] = useState<string>(view.partstat);
    const [busy, setBusy] = useState<Answer | null>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const [told, setTold] = useState<Answer | null>(null);

    const when = view.allDay
        ? formatRange(view.startDate ? `${view.startDate}T00:00:00.000Z` : view.start, view.end, "UTC", locale, true)
        : formatRange(view.start, view.end, zone, locale);

    const reply = async (partstat: Answer) => {
        if (busy) return;
        const before = answer;
        setBusy(partstat);
        setProblem(null);
        if (scope === SERIES) setAnswer(partstat);
        const result = await hostUi.runAction.runAction(
            () => rsvpActions.answerInvitationAction({ token, partstat, recurrenceKey: scope === SERIES ? null : scope }),
            setProblem
        );
        setBusy(null);
        if (!result || !result.ok) {
            if (result && !result.ok) setProblem(result.error);
            setAnswer(before);
            return;
        }
        setTold(partstat);
    };

    const answerText = (value: string) =>
        value === "ACCEPTED" ? t("rsvp.accepted") : value === "DECLINED" ? t("rsvp.declined") : value === "TENTATIVE" ? t("rsvp.tentative") : t("rsvp.notYet");

    return (
        <PublicFrame title={view.title || t("rsvp.untitled")} subtitle={t("rsvp.invitedBy", { name: view.organizer })}>
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
                <p className="text-[13px] font-medium">{when}</p>
                {view.allDay ? null : <p className="text-xs text-foreground-subtle">{t("rsvp.inZone", { zone })}</p>}
                {view.recurring ? <p className="text-xs text-foreground-subtle">{t("rsvp.repeats")}</p> : null}
                {view.location ? (
                    <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                        <MapPin className="size-4" />
                        <span className="min-w-0 break-words">{view.location}</span>
                    </p>
                ) : null}
                {view.conference ? (
                    <a href={view.conference} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[13px] text-foreground underline underline-offset-2">
                        <Video className="size-4" />
                        {t("rsvp.join")}
                    </a>
                ) : null}
                {view.description ? <Linkified text={view.description} className="text-[13px] text-muted-foreground" /> : null}
            </div>

            {view.cancelled ? (
                <StatusNote tone="warning">{t("rsvp.cancelledNote")}</StatusNote>
            ) : (
                <div className="flex flex-col gap-3">
                    <p className="text-[13px] text-muted-foreground">{t("rsvp.answeringAs", { address, answer: answerText(answer) })}</p>
                    {view.occurrences.length > 1 ? (
                        <Select
                            value={scope}
                            onValueChange={setScope}
                            aria-label={t("rsvp.scope")}
                            options={[
                                { value: SERIES, label: t("rsvp.wholeSeries") },
                                ...view.occurrences.map((occurrence) => ({
                                    value: occurrence.key,
                                    label: occurrence.allDay
                                        ? new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(new Date(`${occurrence.key.slice(0, 10)}T00:00:00Z`))
                                        : new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "short", timeZone: zone }).format(new Date(occurrence.start))
                                }))
                            ]}
                        />
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        <Button onClick={() => void reply("ACCEPTED")} disabled={busy !== null} variant={answer === "ACCEPTED" && scope === SERIES ? "primary" : "outline"}>
                            <Check />
                            {t("rsvp.accept")}
                        </Button>
                        <Button onClick={() => void reply("TENTATIVE")} disabled={busy !== null} variant={answer === "TENTATIVE" && scope === SERIES ? "primary" : "outline"}>
                            <CircleHelp />
                            {t("rsvp.maybe")}
                        </Button>
                        <Button onClick={() => void reply("DECLINED")} disabled={busy !== null} variant={answer === "DECLINED" && scope === SERIES ? "primary" : "outline"}>
                            <X />
                            {t("rsvp.decline")}
                        </Button>
                    </div>
                    {told ? <StatusNote tone="success">{t("rsvp.sent", { answer: answerText(told) })}</StatusNote> : null}
                    {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
                </div>
            )}
        </PublicFrame>
    );
}
