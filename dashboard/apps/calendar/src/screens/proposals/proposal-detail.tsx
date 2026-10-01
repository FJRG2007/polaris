"use client";

/**
 * One proposal for its owner: who answered what for each date, which date most
 * people can make, and the button that settles it - the event is written with
 * everybody invited and the proposal closes.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCalendarT } from "../i18n";
import { useMemo, useState } from "react";
import { hostUi } from "@polaris/app-host/client";
import { ProposalEditor } from "./proposal-editor";
import type { CalendarSummary } from "../../lib/wire";
import { formatRange, StatusNote } from "../public/kit";
import type { Vote } from "../../lib/scheduling-schemas";
import * as proposalActions from "../../actions/proposals";
import * as calendarActions from "../../actions/calendars";
import type { ProposalView } from "../../lib/scheduling-wire";
import { Check, CircleHelp, Minus, Pencil, Trash2, X } from "lucide-react";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";
import { Button, Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, Select, Skeleton, cn } from "@polaris/ui";

function VoteMark({ vote, label }: { vote: Vote | undefined; label: string }) {
    const icon =
        vote === "yes" ? (
            <Check className="size-4 text-success" />
        ) : vote === "maybe" ? (
            <CircleHelp className="size-4 text-warning" />
        ) : vote === "no" ? (
            <X className="size-4 text-danger" />
        ) : (
            <Minus className="size-4 text-foreground-subtle" />
        );
    return (
        <span role="img" aria-label={label} title={label} className="inline-flex">
            {icon}
        </span>
    );
}

export function ProposalDetail({ proposalId }: { proposalId: string }) {
    const t = useCalendarT();
    const locale = hostUi.i18nProvider.useLocale();
    const router = useRouter();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const [editing, setEditing] = useState(false);
    const [choosing, setChoosing] = useState<string | null>(null);
    const [calendarId, setCalendarId] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const read = useCachedRead<ProposalView>(cacheKey("proposal", proposalId), async () => (await unwrap(() => proposalActions.proposalAction(proposalId), t("proposals.failed"))).proposal);
    const calendars = useCachedRead<CalendarSummary[]>(
        choosing ? cacheKey("calendars", "writable") : null,
        async () => (await unwrap(() => calendarActions.listCalendarsAction(), t("proposals.failed"))).calendars.filter((calendar) => calendar.writable && calendar.kind !== "resource")
    );
    const proposal = read.data;

    const tally = useMemo(() => {
        if (!proposal) return new Map<string, { yes: number; maybe: number; no: number; requiredNo: number }>();
        return new Map(
            proposal.dates.map((date) => {
                const counts = { yes: 0, maybe: 0, no: 0, requiredNo: 0 };
                for (const person of proposal.participants) {
                    const vote = person.votes[date.id];
                    if (vote) counts[vote] += 1;
                    if (vote === "no" && person.required) counts.requiredNo += 1;
                }
                return [date.id, counts];
            })
        );
    }, [proposal]);
    const best = useMemo(() => {
        if (!proposal) return null;
        let found: string | null = null;
        let score = -1;
        for (const date of proposal.dates) {
            const counts = tally.get(date.id)!;
            const value = counts.requiredNo > 0 ? -1 : counts.yes * 2 + counts.maybe;
            if (value > score) {
                score = value;
                found = date.id;
            }
        }
        return score > 0 ? found : null;
    }, [proposal, tally]);

    const voteLabel = (vote: Vote | undefined) =>
        vote === "yes" ? t("proposals.vote.yes") : vote === "maybe" ? t("proposals.vote.maybe") : vote === "no" ? t("proposals.vote.no") : t("proposals.vote.none");

    const choose = async () => {
        if (!proposal || !choosing || !calendarId || busy) return;
        setBusy(true);
        setProblem(null);
        try {
            const answer = await unwrap(() => proposalActions.chooseProposalDateAction({ proposalId: proposal.id, dateId: choosing, calendarId }), t("proposals.failed"));
            read.replace({ ...proposal, status: "closed", objectId: answer.objectId, calendarId });
            dropCached("proposals");
            setChoosing(null);
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!proposal) return;
        const ok = await confirm({ title: t("proposals.deleteTitle", { title: proposal.title }), description: t("proposals.deleteBody"), confirmLabel: t("proposals.delete"), danger: true });
        if (!ok) return;
        try {
            await unwrap(() => proposalActions.deleteProposalAction(proposal.id), t("proposals.failed"));
            dropCached("proposals");
            router.push("/calendar/proposals");
        } catch (caught) {
            setProblem(caught instanceof Error ? caught.message : String(caught));
        }
    };

    if (read.error) return <StatusNote tone="danger">{read.error}</StatusNote>;
    if (!proposal) {
        return (
            <div className="flex flex-col gap-2">
                <Skeleton className="h-6 w-64" />
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }

    if (editing) {
        return (
            <ProposalEditor
                proposal={proposal}
                onCancel={() => setEditing(false)}
                onSaved={(saved) => {
                    read.replace(saved);
                    dropCached("proposals");
                    setEditing(false);
                }}
            />
        );
    }

    const zone = proposal.timezone || "UTC";
    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-[14px] font-semibold">{proposal.title}</h2>
                    <p className="text-xs text-foreground-subtle">
                        {[proposal.location, t("proposals.minutes", { count: proposal.durationMinutes }), zone].filter(Boolean).join(", ")}
                    </p>
                    {proposal.description ? <p className="mt-1 whitespace-pre-wrap text-[13px] text-muted-foreground">{proposal.description}</p> : null}
                </div>
                <div className="flex items-center gap-1">
                    <span
                        className={cn(
                            "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                            proposal.status === "open" ? "border-success-edge bg-success-soft text-success-ink" : "border-border bg-muted text-muted-foreground"
                        )}
                    >
                        {proposal.status === "open" ? t("proposals.open") : t("proposals.closedBadge")}
                    </span>
                    {proposal.status === "open" ? (
                        <Button size="icon-sm" variant="ghost" aria-label={t("proposals.edit")} title={t("proposals.edit")} onClick={() => setEditing(true)}>
                            <Pencil />
                        </Button>
                    ) : null}
                    <Button size="icon-sm" variant="ghost" aria-label={t("proposals.delete")} title={t("proposals.delete")} onClick={() => void remove()}>
                        <Trash2 />
                    </Button>
                </div>
            </div>

            {proposal.status === "closed" && proposal.objectId ? (
                <StatusNote tone="success">
                    {t("proposals.settled")}{" "}
                    <Link className="underline underline-offset-2" href={`/calendar/e/${proposal.objectId}`}>
                        {t("proposals.openEvent")}
                    </Link>
                </StatusNote>
            ) : null}
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}

            <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full min-w-[32rem] text-[13px]">
                    <thead>
                        <tr className="border-b border-border">
                            <th className="px-3 py-2 text-left">{t("proposals.person")}</th>
                            {proposal.dates.map((date) => (
                                <th key={date.id} className={cn("px-2 py-2 text-center", best === date.id && "bg-success-soft")}>
                                    <span className="block normal-case tracking-normal text-foreground">{formatRange(date.start, new Date(Date.parse(date.start) + proposal.durationMinutes * 60_000).toISOString(), zone, locale)}</span>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {proposal.participants.map((person) => (
                            <tr key={person.id} className="border-b border-border last:border-b-0">
                                <td className="max-w-0 px-3 py-2">
                                    <div className="truncate" title={person.email}>
                                        {person.name || person.email}
                                    </div>
                                    <div className="truncate text-xs text-foreground-subtle">{person.required ? t("proposals.required") : t("proposals.optional")}{person.respondedAt ? "" : `, ${t("proposals.noAnswer")}`}</div>
                                </td>
                                {proposal.dates.map((date) => (
                                    <td key={date.id} className={cn("px-2 py-2 text-center", best === date.id && "bg-success-soft")}>
                                        <VoteMark vote={person.votes[date.id]} label={voteLabel(person.votes[date.id])} />
                                    </td>
                                ))}
                            </tr>
                        ))}
                        <tr className="border-t border-border">
                            <td className="px-3 py-2 text-xs text-foreground-subtle">{t("proposals.totals")}</td>
                            {proposal.dates.map((date) => {
                                const counts = tally.get(date.id)!;
                                return (
                                    <td key={date.id} className={cn("px-2 py-2 text-center", best === date.id && "bg-success-soft")}>
                                        <div className="text-xs tabular-nums text-muted-foreground">{t("proposals.tally", { yes: counts.yes, maybe: counts.maybe })}</div>
                                        {proposal.status === "open" ? (
                                            <Button
                                                size="xs"
                                                variant={best === date.id ? "primary" : "outline"}
                                                className="mt-1"
                                                onClick={() => {
                                                    setChoosing(date.id);
                                                    setProblem(null);
                                                }}
                                            >
                                                {t("proposals.choose")}
                                            </Button>
                                        ) : null}
                                    </td>
                                );
                            })}
                        </tr>
                    </tbody>
                </table>
            </div>

            <Dialog open={choosing !== null} onOpenChange={(open) => !open && setChoosing(null)}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t("proposals.chooseTitle")}</DialogTitle>
                    </DialogHeader>
                    <p className="text-[13px] text-muted-foreground">{t("proposals.chooseBody")}</p>
                    {calendars.loading ? (
                        <Skeleton className="h-8 w-full" />
                    ) : (
                        <Select
                            value={calendarId}
                            onValueChange={setCalendarId}
                            placeholder={t("proposals.pickCalendar")}
                            aria-label={t("proposals.pickCalendar")}
                            options={(calendars.data ?? []).map((calendar) => ({ value: calendar.id, label: calendar.name }))}
                        />
                    )}
                    {calendars.error ? <StatusNote tone="danger">{calendars.error}</StatusNote> : null}
                    {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
                    <DialogFooter>
                        <Button variant="ghost" onClick={() => setChoosing(null)}>
                            {t("proposals.cancel")}
                        </Button>
                        <Button onClick={() => void choose()} disabled={busy} aria-disabled={!calendarId || busy}>
                            {t("proposals.confirmChoice")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
            {confirmElement}
        </div>
    );
}
