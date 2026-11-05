"use client";

/**
 * The groups of the machines list, a page at a time: the server draws the first
 * page of each, and "Load more" asks for the next one after the last row shown.
 */

import Link from "next/link";
import { Button } from "@polaris/ui";
import { Loader2 } from "lucide-react";
import { machinePageAction } from "./actions";
import { useState, useTransition } from "react";
import { machineHref } from "@/lib/machines/machine-links";
import type { WatchCard } from "@/lib/watch-overview-service";
import { WatchCardList } from "@/app/(app)/watch/watch-cards";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DomainDevice } from "@/lib/machines/machines-service";

type Kind = "servers" | "containers" | "domains";

/** Rows shown so far, where the next page starts, and the button that reads it. */
function usePages<T extends { id: string }>(kind: Kind, initial: T[], first: string | null) {
    const [items, setItems] = useState(initial);
    const [next, setNext] = useState(first);
    const [failed, setFailed] = useState(false);
    const [loading, startLoading] = useTransition();
    const more = () => {
        if (!next) return;
        setFailed(false);
        startLoading(async () => {
            const page = await machinePageAction({ kind, cursor: next }).catch(() => null);
            if (!page) {
                setFailed(true);
                return;
            }
            // The kind asked is the kind answered. A row that moved between pages
            // is shown once, where it was first seen.
            setItems((shown) => {
                const seen = new Set(shown.map((item) => item.id));
                return [...shown, ...(page.items as unknown as T[]).filter((item) => !seen.has(item.id))];
            });
            setNext(page.next);
        });
    };
    return { items, next, failed, loading, more };
}

function MoreButton({
    next,
    failed,
    loading,
    more
}: {
    next: string | null;
    failed: boolean;
    loading: boolean;
    more: () => void;
}) {
    const t = useTranslations("servers");
    if (!next) return null;
    return (
        <div className="flex flex-wrap items-center gap-3">
            <Button size="sm" variant="outline" onClick={more} disabled={loading}>
                {loading ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
                {t("machines.loadMore")}
            </Button>
            {failed ? (
                <p role="alert" className="text-sm text-danger">
                    {t("machines.moreFailed")}
                </p>
            ) : null}
        </div>
    );
}

export function MachineCards({
    kind,
    cards,
    next,
    empty,
    label
}: {
    kind: "servers" | "containers";
    cards: WatchCard[];
    next: string | null;
    empty: string;
    label: string;
}) {
    const pages = usePages(kind, cards, next);
    return (
        <div className="flex flex-col gap-3">
            <WatchCardList cards={pages.items} empty={empty} label={label} />
            <MoreButton {...pages} />
        </div>
    );
}

export function MachineDomains({ rows, next }: { rows: DomainDevice[]; next: string | null }) {
    const t = useTranslations("servers");
    const pages = usePages("domains", rows, next);
    if (pages.items.length === 0)
        return <p className="text-sm text-muted-foreground">{t("machines.noDomains")}</p>;
    return (
        <div className="flex flex-col gap-3">
            <ul className="flex flex-col divide-y rounded-md border">
                {pages.items.map((row) => (
                    <li key={row.id} className="min-w-0">
                        <Link
                            href={machineHref("domain", row.id)}
                            className="flex min-w-0 items-center gap-3 px-3 py-2 text-sm hover:bg-muted"
                        >
                            <span
                                aria-hidden
                                className={`size-2 shrink-0 rounded-full ${
                                    row.status === "up"
                                        ? "bg-success"
                                        : row.status === "down"
                                          ? "bg-danger"
                                          : "bg-muted-foreground"
                                }`}
                            />
                            <span className="min-w-0 flex-1 truncate" title={row.hostname}>
                                {row.hostname}
                            </span>
                            <span
                                className="min-w-0 max-w-[40%] truncate text-xs text-muted-foreground"
                                title={row.service || t("machines.lent")}
                            >
                                {row.service || t("machines.lent")}
                            </span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {t(`machines.${row.status ?? "unknown"}`)}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
            <MoreButton {...pages} />
        </div>
    );
}
