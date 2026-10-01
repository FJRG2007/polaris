"use client";

/**
 * Meeting proposals: the list, the new-proposal form, and the section of the
 * calendar's sidebar that shows the open ones.
 */

import Link from "next/link";
import { useCalendarT } from "../i18n";
import { StatusNote } from "../public/kit";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { hostUi } from "@polaris/app-host/client";
import { ProposalEditor } from "./proposal-editor";
import type { SidebarSectionSlotProps } from "../slots";
import * as proposalActions from "../../actions/proposals";
import { CalendarClock, Plus, Trash2 } from "lucide-react";
import { Button, EmptyState, Skeleton, cn } from "@polaris/ui";
import type { ProposalSummary } from "../../lib/scheduling-wire";
import { cacheKey, dropCached, unwrap, useCachedRead } from "../cached-read";

function useProposals() {
    const t = useCalendarT();
    return useCachedRead<ProposalSummary[]>(
        cacheKey("proposals"),
        async () =>
            (await unwrap(() => proposalActions.listProposalsAction(), t("proposals.failed")))
                .proposals
    );
}

export function ProposalsView() {
    const t = useCalendarT();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const read = useProposals();
    const list = read.data;
    const [problem, setProblem] = useState<string | null>(null);

    const remove = async (proposal: ProposalSummary) => {
        if (!list) return;
        const ok = await confirm({
            title: t("proposals.deleteTitle", { title: proposal.title }),
            description: t("proposals.deleteBody"),
            confirmLabel: t("proposals.delete"),
            danger: true
        });
        if (!ok) return;
        setProblem(null);
        read.replace(list.filter((entry) => entry.id !== proposal.id));
        try {
            await unwrap(
                () => proposalActions.deleteProposalAction(proposal.id),
                t("proposals.failed")
            );
            dropCached("proposal", proposal.id);
        } catch (caught) {
            read.replace(list);
            setProblem(caught instanceof Error ? caught.message : String(caught));
        }
    };

    return (
        <div className="flex flex-col gap-3">
            <div className="flex justify-end">
                <Button asChild size="sm">
                    <Link href="/calendar/proposals/new">
                        <Plus />
                        {t("proposals.new")}
                    </Link>
                </Button>
            </div>
            {read.error ? <StatusNote tone="danger">{read.error}</StatusNote> : null}
            {problem ? <StatusNote tone="danger">{problem}</StatusNote> : null}
            {read.loading ? (
                <div className="flex flex-col gap-1.5">
                    {[0, 1, 2].map((index) => (
                        <Skeleton key={index} className="h-14 w-full" />
                    ))}
                </div>
            ) : list && list.length === 0 ? (
                <EmptyState
                    icon={<CalendarClock />}
                    title={t("proposals.emptyTitle")}
                    description={t("proposals.emptyBody")}
                    action={
                        <Button asChild size="sm">
                            <Link href="/calendar/proposals/new">
                                <Plus />
                                {t("proposals.new")}
                            </Link>
                        </Button>
                    }
                />
            ) : (
                <ul className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card">
                    {list?.map((proposal) => (
                        <li key={proposal.id} className="group flex items-center gap-3 px-3 py-2.5">
                            <Link
                                href={`/calendar/proposals/${proposal.id}`}
                                className="min-w-0 flex-1 no-underline"
                            >
                                <div
                                    className="truncate text-[13px] font-medium text-foreground"
                                    title={proposal.title}
                                >
                                    {proposal.title}
                                </div>
                                <div className="text-xs text-foreground-subtle">
                                    {t("proposals.summaryLine", {
                                        dates: proposal.dates,
                                        answered: proposal.answered,
                                        people: proposal.participants
                                    })}
                                </div>
                            </Link>
                            <span
                                className={cn(
                                    "shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium",
                                    proposal.status === "open"
                                        ? "border-success-edge bg-success-soft text-success-ink"
                                        : "border-border bg-muted text-muted-foreground"
                                )}
                            >
                                {proposal.status === "open"
                                    ? t("proposals.open")
                                    : t("proposals.closedBadge")}
                            </span>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                className="md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                                aria-label={t("proposals.deleteNamed", { title: proposal.title })}
                                title={t("proposals.deleteNamed", { title: proposal.title })}
                                onClick={() => void remove(proposal)}
                            >
                                <Trash2 />
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {confirmElement}
        </div>
    );
}

/** The new-proposal form, going to the proposal once it is made. */
export function NewProposal() {
    const router = useRouter();
    return (
        <ProposalEditor
            proposal={null}
            onCancel={() => router.push("/calendar/proposals")}
            onSaved={(proposal) => {
                dropCached("proposals");
                router.push(`/calendar/proposals/${proposal.id}`);
            }}
        />
    );
}

/** The calendar sidebar's list of open proposals. */
export function ProposalsSection(_props: SidebarSectionSlotProps) {
    const t = useCalendarT();
    const read = useProposals();
    const open = (read.data ?? []).filter((proposal) => proposal.status === "open").slice(0, 5);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-2 px-1">
                <h3 className="text-[11px] font-medium uppercase tracking-wider text-foreground-subtle">
                    {t("proposals.backToList")}
                </h3>
                <Link
                    href="/calendar/proposals"
                    className="text-xs text-muted-foreground no-underline hover:text-foreground"
                >
                    {t("proposals.manage")}
                </Link>
            </div>
            {read.loading ? (
                <Skeleton className="h-5 w-40" />
            ) : open.length === 0 ? (
                <Link
                    href="/calendar/proposals/new"
                    className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-xs text-muted-foreground no-underline hover:text-foreground"
                >
                    <Plus className="size-3.5" />
                    {t("proposals.new")}
                </Link>
            ) : (
                open.map((proposal) => (
                    <Link
                        key={proposal.id}
                        href={`/calendar/proposals/${proposal.id}`}
                        className="flex items-center gap-2 rounded px-1 py-0.5 text-[13px] text-foreground no-underline hover:bg-card-hover"
                    >
                        <CalendarClock className="size-3.5 text-foreground-subtle" />
                        <span className="min-w-0 flex-1 truncate" title={proposal.title}>
                            {proposal.title}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-foreground-subtle">
                            {proposal.answered}/{proposal.participants}
                        </span>
                    </Link>
                ))
            )}
        </div>
    );
}
