"use client";

/**
 * What sits around the search box: the operators offered while typing one, the
 * searches made recently, the chips a search is taken apart into, and the
 * switch between newest first and best match first.
 *
 * Recent searches are this browser's convenience, kept in its own storage and
 * nowhere else; a browser that will not keep them simply has none.
 */

import { cn } from "@polaris/ui";
import * as core from "@polaris/core";
import { Clock, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";

const RECENT_KEY = "polaris.mail.recent-searches";

function readRecent(): string[] {
    try {
        const raw = window.localStorage.getItem(RECENT_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed
                  .filter((one): one is string => typeof one === "string")
                  .slice(0, core.RECENT_MAIL_SEARCHES)
            : [];
    } catch {
        return [];
    }
}

function writeRecent(list: readonly string[]): void {
    try {
        window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
        // A private window or blocked storage: the list lives for this page only.
    }
}

/** The recent searches, and the two ways to change them. */
export function useRecentSearches() {
    const [recent, setRecent] = useState<string[]>([]);
    useEffect(() => setRecent(readRecent()), []);
    const remember = useCallback((query: string) => {
        setRecent((held) => {
            const next = core.rememberMailSearch(held, query);
            writeRecent(next);
            return next;
        });
    }, []);
    const forget = useCallback(() => {
        writeRecent([]);
        setRecent([]);
    }, []);
    return { recent, remember, forget };
}

/** One choice in the list under the box. */
export type SearchOffer =
    | {
          readonly kind: "operator";
          readonly insert: string;
          readonly key: core.MailSearchOperatorKey;
      }
    | { readonly kind: "recent"; readonly query: string };

/** What the list under the box offers for what is typed. */
export function searchOffers(typed: string, recent: readonly string[]): SearchOffer[] {
    const hints = core.mailSearchOperatorHints(typed);
    if (hints.length > 0)
        return hints.map((hint) => ({ kind: "operator", insert: hint.insert, key: hint.key }));
    if (!typed.trim()) return recent.map((query) => ({ kind: "recent", query }));
    return [];
}

/** The list under the box. */
export function SearchOffers({
    offers,
    active,
    onPick,
    onForget
}: {
    offers: readonly SearchOffer[];
    active: number;
    onPick: (offer: SearchOffer) => void;
    onForget: () => void;
}) {
    const t = useTranslations("mail");
    if (offers.length === 0) return null;
    const recent = offers[0]?.kind === "recent";
    return (
        <div
            className="absolute start-0 end-0 top-full z-30 mt-1 max-h-72 overflow-y-auto overscroll-contain rounded-md border border-border bg-surface py-1 shadow-lg"
            data-search-offers=""
            // A press here would blur the box before the click lands.
            onMouseDown={(event) => event.preventDefault()}
        >
            <div className="flex items-center justify-between px-2 py-1 text-[11px] text-foreground-subtle">
                <span>{recent ? t("searchBox.recent") : t("searchBox.operators")}</span>
                {recent ? (
                    <button type="button" className="hover:text-foreground" onClick={onForget}>
                        {t("searchBox.clearRecent")}
                    </button>
                ) : null}
            </div>
            <ul
                role="listbox"
                aria-label={recent ? t("searchBox.recent") : t("searchBox.operators")}
            >
                {offers.map((offer, index) => (
                    <li
                        key={offer.kind === "recent" ? `r-${offer.query}` : `o-${offer.insert}`}
                        role="option"
                        aria-selected={index === active}
                        className={cn(
                            "flex min-w-0 cursor-pointer items-center gap-2 px-2 py-1 text-[12px]",
                            index === active ? "bg-accent text-foreground" : "text-muted-foreground"
                        )}
                        onClick={() => onPick(offer)}
                    >
                        {offer.kind === "recent" ? (
                            <>
                                <Clock className="size-3.5 shrink-0" aria-hidden />
                                <span className="min-w-0 flex-1 truncate" title={offer.query}>
                                    {offer.query}
                                </span>
                            </>
                        ) : (
                            <>
                                <code className="shrink-0 font-mono text-[11px] text-foreground">
                                    {offer.insert}
                                </code>
                                <span className="min-w-0 flex-1 truncate">
                                    {t(`searchBox.op.${offer.key}`)}
                                </span>
                            </>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** The applied search as chips, each one taken off on its own, and the order. */
export function SearchChips({
    applied,
    onChange
}: {
    applied: string;
    onChange: (query: string) => void;
}) {
    const t = useTranslations("mail");
    if (!applied.trim()) return null;
    const terms = core.parseMailSearch(applied);
    const chips = core.mailSearchChips(terms);
    const searching = !core.searchIsEmpty(terms);
    if (!searching) return null;
    const order = (next: core.MailSearchOrder) =>
        onChange(core.formatMailSearch({ ...terms, order: next }));
    return (
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1" data-search-chips="">
            {chips.map((chip) => {
                const label =
                    chip.operator === '"'
                        ? `"${chip.value}"`
                        : chip.operator === "-"
                          ? `-${chip.value}`
                          : `${chip.operator}:${chip.value}`;
                return (
                    <span
                        key={chip.id}
                        className="flex min-w-0 max-w-full items-center gap-0.5 rounded-full border border-border bg-background ps-2 pe-0.5 text-[11px] text-foreground"
                    >
                        <span className="min-w-0 truncate font-mono" title={label}>
                            {label}
                        </span>
                        <button
                            type="button"
                            className="shrink-0 rounded-full p-0.5 text-foreground-subtle hover:text-foreground"
                            aria-label={t("searchBox.removeFilter", { filter: label })}
                            title={t("searchBox.removeFilter", { filter: label })}
                            onClick={() =>
                                onChange(
                                    core.formatMailSearch(
                                        core.withoutMailSearchChip(terms, chip.id)
                                    )
                                )
                            }
                        >
                            <X className="size-3 shrink-0" aria-hidden />
                        </button>
                    </span>
                );
            })}
            <div
                className="ms-auto flex shrink-0 items-center rounded-md border border-border text-[11px]"
                role="group"
                aria-label={t("searchBox.order")}
            >
                {(["date", "relevance"] as const).map((one) => (
                    <button
                        key={one}
                        type="button"
                        aria-pressed={terms.order === one}
                        className={cn(
                            "px-2 py-0.5",
                            terms.order === one
                                ? "bg-accent font-medium text-foreground"
                                : "text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => order(one)}
                    >
                        {one === "date" ? t("searchBox.byDate") : t("searchBox.byRelevance")}
                    </button>
                ))}
            </div>
        </div>
    );
}
