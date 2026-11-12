"use client";

/**
 * ModelSelector: provider and model, how hard it thinks, and who pays.
 *
 * Ported from AI Elements (github.com/vercel/ai-elements,
 * packages/elements/src/model-selector.tsx at ca8be60), Apache-2.0 - see the
 * LICENSE beside this file. Changed: built on the Polaris dropdown menu (a
 * portal with collision handling) instead of a dialog with a command list,
 * with the intelligence and payer sections Polar needs, and only the models
 * the server says this person can use - it never offers one of its own.
 *
 * A search field sits on top: a long list of models is found by a name half
 * remembered, so the match is fuzzy (Fuse) over the model's name, its id and
 * its provider, and what survives keeps its provider heading.
 *
 * "Automatic" sits above every provider: Polar picks the model per message.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { Check, Shuffle } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IntegrationLogo } from "@/components/logos";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuSearch
} from "@polaris/ui";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    automaticChoice,
    INTELLIGENCE_LEVELS,
    isAutomatic,
    type ModelChoice,
    type Payer
} from "@/lib/polar/shared";

export interface ModelSelectorProvider {
    provider: string;
    name: string;
    payers: Payer[];
    models: Array<{
        provider: string;
        model: string;
        name: string;
        reasoning: boolean;
        attachment?: boolean;
    }>;
}

/** The first model on offer, for an agent that needs one and has none yet. */
export function firstModel(providers: readonly ModelSelectorProvider[] | null): ModelChoice | null {
    const provider = providers?.find((entry) => entry.models.length > 0);
    const model = provider?.models[0];
    return model
        ? {
              kind: "language",
              provider: model.provider,
              model: model.model,
              intelligence: "balanced",
              payer: null
          }
        : null;
}

type ModelEntry = ModelSelectorProvider["models"][number] & { providerName: string };

/** How loose a match may be: enough for a typo or a dropped letter, not so
 *  loose that every model answers every query. */
const FUSE_THRESHOLD = 0.35;

/**
 * The providers with only the models that match `query`, best match first
 * within each provider, in the providers' own order. Everything when the query
 * is blank.
 */
export function searchModels(
    providers: ModelSelectorProvider[],
    index: Fuse<ModelEntry>,
    query: string
): ModelSelectorProvider[] {
    const term = query.trim();
    if (!term) return providers;
    const found = index.search(term).map((result) => result.item);
    return providers
        .map((entry) => ({
            ...entry,
            models: found
                .filter((model) => model.provider === entry.provider)
                .map(({ providerName: _name, ...model }) => model)
        }))
        .filter((entry) => entry.models.length > 0);
}

export function modelIndex(providers: ModelSelectorProvider[]): Fuse<ModelEntry> {
    return new Fuse(
        providers.flatMap((entry) =>
            entry.models.map((model) => ({ ...model, providerName: entry.name }))
        ),
        { keys: ["name", "model", "providerName"], threshold: FUSE_THRESHOLD, ignoreLocation: true }
    );
}

/** The picker's button on the composer's tool row; Code's agent picker wears it too. */
/** Model rows drawn at first, and added each time the end of the list comes
 *  into view: a catalogue of every provider is thousands of rows, and a menu
 *  only ever shows a screenful of them. */
export const MODELS_PAGE = 60;

/** The providers, cut to the first `limit` models in their order. */
export function firstModels<T extends { models: readonly unknown[] }>(
    providers: readonly T[],
    limit: number
): { shown: T[]; more: boolean } {
    const shown: T[] = [];
    let left = limit;
    for (const entry of providers) {
        if (left <= 0) return { shown, more: true };
        if (entry.models.length <= left) {
            shown.push(entry);
            left -= entry.models.length;
        } else {
            shown.push({ ...entry, models: entry.models.slice(0, left) });
            return { shown, more: true };
        }
    }
    return { shown, more: false };
}

/** The foot of the list: draws the next page once it comes near the view, and
 *  stays an item for whoever moves with the keyboard. */
function MoreModels({ onMore, label }: { onMore: () => void; label: string }) {
    const ref = useRef<HTMLDivElement | null>(null);
    const latest = useRef(onMore);
    latest.current = onMore;
    useEffect(() => {
        const node = ref.current;
        if (!node || typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) latest.current();
            },
            { rootMargin: "200px 0px" }
        );
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    return (
        <DropdownMenuItem
            ref={ref}
            onSelect={(event) => {
                // Stays open: the next rows land right here.
                event.preventDefault();
                onMore();
            }}
            className="justify-center text-xs text-muted-foreground"
        >
            {label}
        </DropdownMenuItem>
    );
}

export const MODEL_TRIGGER =
    "inline-flex h-7 min-w-0 max-w-[60%] items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground hover:bg-card-hover hover:text-foreground";

function Mark({ on }: { on: boolean }) {
    return (
        <Check
            className={on ? "ml-auto h-3.5 w-3.5 text-primary" : "ml-auto h-3.5 w-3.5 opacity-0"}
        />
    );
}

export function ModelSelector({
    providers,
    choice,
    onChoice,
    open,
    onOpenChange,
    forCode = false,
    triggerClassName,
    triggerLabel,
    triggerContent
}: {
    providers: ModelSelectorProvider[];
    choice: ModelChoice | null;
    onChoice: (choice: ModelChoice) => void;
    /** Opened from outside as well as by its own button, when given. */
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    /** For an agent session: no Automatic and no intelligence, which only a
     *  chat turn has. */
    forCode?: boolean;
    /** Replaces the composer's trigger look, for a picker that is a form field
     *  (Polar's routing settings) rather than a chip on the tool row. */
    triggerClassName?: string;
    /** The field's name for assistive tech, when it sits under a label. */
    triggerLabel?: string;
    /** What the button says instead of the chosen model ("Change"), for a
     *  picker beside a row that already names the model. */
    triggerContent?: ReactNode;
}) {
    const t = useTranslations("polar");
    const provider = providers.find((entry) => entry.provider === choice?.provider);
    const model = provider?.models.find((entry) => entry.model === choice?.model);
    const automatic = isAutomatic(choice);
    // Automatic sends a reasoning turn at the chosen level, so it can be set.
    const leveled = automatic || !!model?.reasoning;
    const [query, setQuery] = useState("");
    const index = useMemo(() => modelIndex(providers), [providers]);
    const searching = query.trim().length > 0;
    const found = useMemo(() => searchModels(providers, index, query), [providers, index, query]);
    const [limit, setLimit] = useState(MODELS_PAGE);
    // A new search starts again at the top of its results.
    useEffect(() => setLimit(MODELS_PAGE), [query]);
    const { shown, more } = useMemo(() => firstModels(found, limit), [found, limit]);
    return (
        <DropdownMenu
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    setQuery("");
                    setLimit(MODELS_PAGE);
                }
                onOpenChange?.(next);
            }}
        >
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    title={triggerClassName ? (model?.name ?? t("picker.title")) : t("picker.title")}
                    aria-label={
                        triggerLabel
                            ? `${triggerLabel}: ${automatic ? t("picker.automatic") : (model?.name ?? t("picker.none"))}`
                            : undefined
                    }
                    className={triggerClassName ?? MODEL_TRIGGER}
                >
                    {!triggerContent && provider && !automatic ? (
                        <IntegrationLogo slug={provider.provider} className="size-3.5 shrink-0" />
                    ) : null}
                    {triggerContent ?? (
                        <span className="min-w-0 truncate text-foreground">
                            {automatic ? t("picker.automatic") : (model?.name ?? t("picker.none"))}
                        </span>
                    )}
                    {!triggerContent && choice && leveled ? (
                        <span className="shrink-0">{t(`intelligence.${choice.intelligence}`)}</span>
                    ) : null}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-72 overflow-y-auto overscroll-contain pt-2"
                // Escape empties a search first and closes the menu only once
                // there is nothing left to clear.
                onEscapeKeyDown={(event) => {
                    if (!query) return;
                    event.preventDefault();
                    setQuery("");
                }}
            >
                {providers.length > 0 ? (
                    <MenuSearch
                        value={query}
                        onChange={setQuery}
                        placeholder={t("picker.search")}
                    />
                ) : null}
                {searching && found.length === 0 ? (
                    <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                        {t("picker.noMatch")}
                    </p>
                ) : null}
                {providers.length > 0 && !searching && !forCode ? (
                    <>
                        <DropdownMenuItem
                            onSelect={() => onChoice(automaticChoice(choice?.intelligence))}
                            className="items-start"
                        >
                            <Shuffle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate">{t("picker.automatic")}</span>
                                <span className="text-xs text-muted-foreground">
                                    {t("picker.automaticHint")}
                                </span>
                            </span>
                            <Mark on={automatic} />
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                {shown.map((entry) => (
                    <div key={entry.provider}>
                        <DropdownMenuLabel className="flex min-w-0 items-center gap-1.5">
                            <IntegrationLogo slug={entry.provider} className="size-3.5 shrink-0" />
                            <span className="min-w-0 truncate">{entry.name}</span>
                        </DropdownMenuLabel>
                        {entry.models.map((option) => (
                            <DropdownMenuItem
                                key={option.model}
                                onSelect={() =>
                                    onChoice({
                                        kind: "language",
                                        provider: option.provider,
                                        model: option.model,
                                        intelligence: choice?.intelligence ?? "balanced",
                                        payer: null
                                    })
                                }
                            >
                                <IntegrationLogo
                                    slug={option.provider}
                                    className="size-3.5 shrink-0"
                                />
                                <span className="min-w-0 truncate" title={option.name}>
                                    {option.name}
                                </span>
                                <Mark
                                    on={
                                        option.provider === choice?.provider &&
                                        option.model === choice?.model
                                    }
                                />
                            </DropdownMenuItem>
                        ))}
                    </div>
                ))}
                {more ? (
                    <MoreModels
                        onMore={() => setLimit((current) => current + MODELS_PAGE)}
                        label={t("picker.more")}
                    />
                ) : null}
                {choice && !searching ? (
                    <>
                        <DropdownMenuSeparator />
                        {forCode ? null : (
                            <DropdownMenuLabel>{t("picker.intelligence")}</DropdownMenuLabel>
                        )}
                        {(forCode ? [] : INTELLIGENCE_LEVELS).map((level) => (
                            <DropdownMenuItem
                                key={level}
                                disabled={!leveled}
                                title={leveled ? undefined : t("picker.noReasoning")}
                                onSelect={() => onChoice({ ...choice, intelligence: level })}
                            >
                                {t(`intelligence.${level}`)}
                                <Mark on={choice.intelligence === level} />
                            </DropdownMenuItem>
                        ))}
                        {automatic ? null : (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>{t("picker.payer")}</DropdownMenuLabel>
                            </>
                        )}
                        {(provider?.payers ?? []).map((payer) => (
                            <DropdownMenuItem
                                key={payer}
                                onSelect={() => onChoice({ ...choice, payer })}
                            >
                                {t(`picker.${payer}`)}
                                <Mark on={(choice.payer ?? provider?.payers[0]) === payer} />
                            </DropdownMenuItem>
                        ))}
                        {automatic ? null : (
                            <DropdownMenuItem disabled title={t("picker.signinReason")}>
                                <span className="text-foreground-subtle">{t("picker.signin")}</span>
                            </DropdownMenuItem>
                        )}
                    </>
                ) : null}
                {searching ? null : (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem asChild>
                            <Link href="/account/ai-keys">{t("picker.manage")}</Link>
                        </DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
