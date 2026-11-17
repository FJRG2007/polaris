"use client";

/**
 * One column of the session board and its cards. The list is drawn through a
 * virtualizer, so a Done column scrolled hundreds of sessions down still only
 * has the cards on screen in the page.
 */

import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { AgentLogo } from "@/components/logos";
import { Badge, Skeleton } from "@polaris/ui";
import type { BoardCard } from "@/lib/polar/code-board";
import { useVirtualizer } from "@tanstack/react-virtual";
import { RelativeTime } from "@/components/relative-time";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { BoardColumn as Column } from "@/lib/agents/session-board";
import { CircleCheck, CircleDashed, CircleX, GitBranch, GitPullRequest } from "lucide-react";

/** A card's height before it is measured: two lines of title and two of facts. */
const CARD_ESTIMATE = 118;
/** Skeleton cards while the first read is on its way. */
const SKELETON_CARDS = 3;

type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

const COLUMN_TONE: Record<Column, Tone> = {
    needs_you: "warning",
    working: "primary",
    in_review: "neutral",
    fix_needed: "danger",
    ready: "success",
    done: "neutral"
};

export function boardColumnTone(column: Column): Tone {
    return COLUMN_TONE[column];
}

/** Where a card opens its session: Polar Code, on that session. */
export function sessionHref(id: string): string {
    return `/polar?session=${encodeURIComponent(id)}`;
}

export function BoardColumnBody({
    column,
    cards,
    loading,
    viewerId,
    footer
}: {
    column: Column;
    cards: readonly BoardCard[];
    loading: boolean;
    viewerId: string;
    footer?: ReactNode;
}) {
    const t = useTranslations("polar");
    const scroller = useRef<HTMLDivElement | null>(null);
    const virtual = useVirtualizer({
        count: cards.length,
        getScrollElement: () => scroller.current,
        estimateSize: () => CARD_ESTIMATE,
        overscan: 6,
        gap: 8,
        getItemKey: (index) => cards[index]?.id ?? index
    });

    if (loading) {
        return (
            <div className="flex flex-col gap-2 p-2" aria-hidden>
                {Array.from({ length: SKELETON_CARDS }, (_, index) => (
                    <Skeleton key={index} className="h-[104px] rounded-lg" />
                ))}
            </div>
        );
    }

    return (
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
            {cards.length === 0 ? (
                <p className="px-1 py-2 text-[0.8125rem] leading-5 text-muted-foreground">
                    {t(`board.columnEmpty.${column}`)}
                </p>
            ) : (
                <div role="list" className="relative w-full" style={{ height: virtual.getTotalSize() }}>
                    {virtual.getVirtualItems().map((item) => {
                        const card = cards[item.index];
                        if (!card) return null;
                        return (
                            <div
                                key={item.key}
                                role="listitem"
                                data-index={item.index}
                                ref={virtual.measureElement}
                                className="absolute inset-x-0 top-0"
                                style={{ transform: `translateY(${item.start}px)` }}
                            >
                                <SessionCard card={card} viewerId={viewerId} />
                            </div>
                        );
                    })}
                </div>
            )}
            {footer}
        </div>
    );
}

function SessionCard({ card, viewerId }: { card: BoardCard; viewerId: string }) {
    const t = useTranslations("polar");
    const where = [card.repo || t("board.workspace"), card.branch].filter(Boolean);
    return (
        <article className="group relative flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 transition-colors duration-fast hover:border-border-strong hover:bg-card-hover focus-within:border-border-strong">
            <div className="flex min-w-0 items-start gap-2">
                <Link
                    href={sessionHref(card.id)}
                    prefetch={false}
                    className="min-w-0 flex-1 text-[0.8125rem] font-medium leading-5 text-foreground outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring"
                    title={card.title}
                >
                    <span className="line-clamp-2 break-words">{card.title || t("board.untitled")}</span>
                </Link>
                <Badge variant={statusTone(card.status)} className="mt-0.5">
                    {t(`board.status.${card.status}`)}
                </Badge>
            </div>
            <div className="flex min-w-0 items-center gap-1 text-[0.75rem] text-muted-foreground" title={where.join(" / ")}>
                <GitBranch className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{card.repo || t("board.workspace")}</span>
                {card.branch ? (
                    <>
                        <span aria-hidden className="shrink-0">/</span>
                        <span className="min-w-0 truncate font-mono text-[0.6875rem]" title={card.branch}>{card.branch}</span>
                    </>
                ) : null}
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[0.75rem] text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1" title={card.agent}>
                    <AgentLogo id={card.cli} label={card.agent} className="size-3.5" />
                    <span className="min-w-0 truncate">{card.agent}</span>
                </span>
                {card.personId && card.personId !== viewerId && card.personName ? (
                    <span className="min-w-0 truncate" title={card.personName}>
                        {card.personName}
                    </span>
                ) : null}
                {card.pull ? <PullChip pull={card.pull} /> : null}
                <span className="ms-auto shrink-0 tabular-nums">
                    <RelativeTime iso={card.at} formatStyle="narrow" />
                </span>
            </div>
        </article>
    );
}

function PullChip({ pull }: { pull: NonNullable<BoardCard["pull"]> }) {
    const t = useTranslations("polar");
    const { checks } = pull;
    return (
        <span className="relative z-10 flex min-w-0 items-center gap-1.5">
            <a
                href={pull.url}
                target="_blank"
                rel="noopener noreferrer"
                className="relative flex shrink-0 items-center gap-0.5 rounded hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-x-1 [@media(pointer:coarse)]:before:-inset-y-3.5 [@media(pointer:coarse)]:before:content-['']"
                title={t("board.openPull", { number: pull.number })}
            >
                <GitPullRequest className="size-3.5" aria-hidden />#{pull.number}
            </a>
            {checks.total > 0 ? (
                <span
                    className="flex shrink-0 items-center gap-1 tabular-nums"
                    role="img"
                    aria-label={t("board.checks", {
                        passed: checks.passed,
                        failed: checks.failed,
                        pending: checks.pending
                    })}
                    title={t("board.checks", {
                        passed: checks.passed,
                        failed: checks.failed,
                        pending: checks.pending
                    })}
                >
                    {checks.failed > 0 ? (
                        <span className="flex items-center gap-0.5 text-danger-ink">
                            <CircleX className="size-3.5" aria-hidden />
                            {checks.failed}
                        </span>
                    ) : null}
                    {checks.pending > 0 ? (
                        <span className="flex items-center gap-0.5 text-warning-ink">
                            <CircleDashed className="size-3.5" aria-hidden />
                            {checks.pending}
                        </span>
                    ) : null}
                    {checks.passed > 0 ? (
                        <span className="flex items-center gap-0.5 text-success-ink">
                            <CircleCheck className="size-3.5" aria-hidden />
                            {checks.passed}
                        </span>
                    ) : null}
                </span>
            ) : null}
        </span>
    );
}

function statusTone(status: BoardCard["status"]): Tone {
    switch (status) {
        case "needs_input":
        case "idle":
            return "warning";
        case "working":
            return "primary";
        case "ci_failed":
        case "changes_requested":
        case "commented":
        case "merge_conflict":
            return "danger";
        case "approved":
        case "mergeable":
        case "merged":
            return "success";
        default:
            return "neutral";
    }
}

