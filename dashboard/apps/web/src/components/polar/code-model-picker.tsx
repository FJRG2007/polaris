"use client";

/**
 * Code's one picker: a model, from one of the person's sources. Drawn as the
 * chat's model selector (provider marks, a fuzzy search, rows added as the
 * list scrolls), with each source - a subscription, an API key, the
 * deployment's keys, a machine's own sign-in - as a group, "Recent" on top and
 * the groups in the person's own order. Which tool runs the pick is
 * `resolveCodeEngine`'s business; no tool is named here.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowDownUp, Check, History, KeyRound, Shuffle } from "lucide-react";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    MenuSearch
} from "@polaris/ui";
import { applyOrder } from "@/lib/polar/picker-order";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { AgentLogo, IntegrationLogo } from "@/components/logos";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    AUTOMATIC_PICK,
    isAutomaticPick,
    type CodePick,
    type CodeSource,
    type CodeSourceModel
} from "@/lib/polar/agents/code-sources";
import {
    firstModels,
    MODEL_TRIGGER,
    MODELS_PAGE,
    MoreModels
} from "@/components/polar/elements/model-selector";
import { SourceOrderList } from "@/components/polar/elements/source-order";
import { usePickerPrefs } from "@/components/polar/elements/use-picker-prefs";

type Words = NamespaceTranslator<"polar">;

/** What a source is called: its kind ("Claude subscription", "OpenRouter"). */
export function sourceTitle(source: CodeSource, t: Words): string {
    if (source.kind === "polar") return source.label;
    return t(`code.sources.${source.label}` as Parameters<Words>[0]);
}

/** Whose it is: the account, the machine, or the deployment. */
export function sourceDetail(source: CodeSource, t: Words): string | null {
    if (source.kind === "machine") return t("code.sources.machine");
    if (source.kind === "server") return t("code.sources.provided");
    if (source.mine === false) {
        return source.account
            ? t("code.sources.sharedAccount", { account: source.account })
            : t("code.sources.provided");
    }
    return source.account;
}

export function SourceMark({ source, className }: { source: CodeSource; className: string }) {
    if (source.logo) return <IntegrationLogo slug={source.logo} className={className} />;
    const engine = source.engines[0];
    return engine ? (
        <AgentLogo id={engine} label={source.vendor} className={className} />
    ) : (
        <KeyRound className={className} aria-hidden />
    );
}

function Mark({ on }: { on: boolean }) {
    return <Check className={cn("ml-auto size-3.5 shrink-0 text-primary", !on && "opacity-0")} />;
}

interface Row {
    readonly source: string;
    readonly title: string;
    readonly model: CodeSourceModel;
    readonly name: string;
}

const same = (pick: CodePick | null, source: string, model: string | null) =>
    pick?.source === source && pick.model === model;

export function CodeModelPicker({
    sources,
    value,
    onChange,
    automatic,
    disabled
}: {
    /** Null while they are on their way. */
    sources: readonly CodeSource[] | null;
    value: CodePick | null;
    onChange: (pick: CodePick) => void;
    /** Whether Polar's Automatic is offered. */
    automatic: boolean;
    disabled: boolean;
}) {
    const t = useTranslations("polar");
    const { prefs, setOrder, failed } = usePickerPrefs();
    const [query, setQuery] = useState("");
    const [ordering, setOrdering] = useState(false);
    const [limit, setLimit] = useState(MODELS_PAGE);
    useEffect(() => setLimit(MODELS_PAGE), [query]);

    const ordered = useMemo(
        () => applyOrder(sources ?? [], (source) => source.key, prefs.order),
        [sources, prefs.order]
    );
    const rowName = (model: CodeSourceModel) => (model.model ? model.name : t("code.sources.default"));
    const rows = useMemo<Row[]>(
        () =>
            ordered.flatMap((source) =>
                source.models.map((model) => ({
                    source: source.key,
                    title: `${sourceTitle(source, t)} ${sourceDetail(source, t) ?? ""}`,
                    model,
                    name: model.model ? model.name : t("code.sources.default")
                }))
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [ordered]
    );
    const index = useMemo(
        () => new Fuse(rows, { keys: ["name", "model.model", "title"], threshold: 0.35, ignoreLocation: true }),
        [rows]
    );
    const searching = query.trim().length > 0;
    const groups = useMemo(() => {
        const found = searching ? index.search(query.trim()).map((result) => result.item) : rows;
        return ordered
            .map((source) => ({ source, models: found.filter((row) => row.source === source.key) }))
            .filter((group) => group.models.length > 0);
    }, [ordered, rows, index, query, searching]);
    const { shown, more } = useMemo(() => firstModels(groups, limit), [groups, limit]);
    const recent = useMemo(
        () =>
            prefs.recent.flatMap((pick) => {
                const source = ordered.find((entry) => entry.key === pick.source);
                const model = source?.models.find((entry) => entry.model === pick.model);
                return source && model ? [{ source, model }] : [];
            }),
        [prefs.recent, ordered]
    );

    const source = ordered.find((entry) => entry.key === value?.source) ?? null;
    const model = source?.models.find((entry) => entry.model === (value?.model ?? null)) ?? null;
    const auto = isAutomaticPick(value);
    const label = auto
        ? t("picker.automatic")
        : source
          ? `${model ? rowName(model) : (value?.model ?? t("code.sources.default"))} - ${sourceTitle(source, t)}`
          : t("picker.none");
    const pick = (entry: CodeSource, row: CodeSourceModel) =>
        onChange({ source: entry.key, provider: row.provider, model: row.model });

    return (
        <DropdownMenu
            onOpenChange={(next) => {
                if (next) return;
                setQuery("");
                setOrdering(false);
                setLimit(MODELS_PAGE);
            }}
        >
            <DropdownMenuTrigger asChild disabled={disabled || sources === null}>
                <button
                    type="button"
                    title={label}
                    aria-label={`${t("code.model")}: ${label}`}
                    className={cn(MODEL_TRIGGER, "disabled:opacity-60")}
                >
                    {auto ? (
                        <Shuffle className="size-3.5 shrink-0" aria-hidden />
                    ) : source ? (
                        <SourceMark source={source} className="size-3.5 shrink-0" />
                    ) : (
                        <KeyRound className="size-3.5 shrink-0" aria-hidden />
                    )}
                    <span className="min-w-0 truncate text-foreground" title={label}>{label}</span>
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain pt-2"
                onEscapeKeyDown={(event) => {
                    if (!query) return;
                    event.preventDefault();
                    setQuery("");
                }}
            >
                {ordering ? (
                    <>
                        <DropdownMenuLabel>{t("picker.order")}</DropdownMenuLabel>
                        <SourceOrderList
                            entries={ordered.map((entry) => ({
                                key: entry.key,
                                name: [sourceTitle(entry, t), sourceDetail(entry, t)].filter(Boolean).join(" - "),
                                icon: <SourceMark source={entry} className="size-3.5 shrink-0" />
                            }))}
                            order={prefs.order}
                            onOrder={setOrder}
                        />
                        {failed ? (
                            <p role="alert" className="px-2 pb-1 text-xs text-danger-ink">
                                {t("picker.orderFailed")}
                            </p>
                        ) : null}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={(event) => {
                                event.preventDefault();
                                setOrdering(false);
                            }}
                        >
                            {t("picker.orderDone")}
                        </DropdownMenuItem>
                    </>
                ) : (
                    <>
                        {rows.length > 0 ? (
                            <MenuSearch value={query} onChange={setQuery} placeholder={t("picker.search")} />
                        ) : null}
                        {searching && groups.length === 0 ? (
                            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
                                {t("picker.noMatch")}
                            </p>
                        ) : null}
                        {!searching && automatic ? (
                            <>
                                <DropdownMenuItem onSelect={() => onChange(AUTOMATIC_PICK)} className="items-start">
                                    <Shuffle className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
                                    <span className="flex min-w-0 flex-col">
                                        <span className="truncate">{t("picker.automatic")}</span>
                                        <span className="text-xs text-muted-foreground">
                                            {t("picker.automaticHint")}
                                        </span>
                                    </span>
                                    <Mark on={auto} />
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                            </>
                        ) : null}
                        {!searching && recent.length > 0 ? (
                            <>
                                <DropdownMenuLabel className="flex items-center gap-1.5">
                                    <History className="size-3.5 shrink-0" aria-hidden />
                                    {t("picker.recent")}
                                </DropdownMenuLabel>
                                {recent.map((entry) => (
                                    <DropdownMenuItem
                                        key={`recent-${entry.source.key}-${entry.model.model ?? ""}`}
                                        onSelect={() => pick(entry.source, entry.model)}
                                    >
                                        <SourceMark source={entry.source} className="size-3.5 shrink-0" />
                                        <span className="min-w-0 truncate" title={rowName(entry.model)}>
                                            {rowName(entry.model)}
                                        </span>
                                        <span className="min-w-0 shrink truncate text-xs text-muted-foreground">
                                            {sourceTitle(entry.source, t)}
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                                <DropdownMenuSeparator />
                            </>
                        ) : null}
                        {shown.map((group) => {
                            const detail = sourceDetail(group.source, t);
                            return (
                                <div key={group.source.key} data-source={group.source.key}>
                                    <DropdownMenuLabel className="flex min-w-0 items-center gap-1.5">
                                        <SourceMark source={group.source} className="size-3.5 shrink-0" />
                                        <span className="min-w-0 truncate" title={sourceTitle(group.source, t)}>
                                            {sourceTitle(group.source, t)}
                                        </span>
                                        {detail ? (
                                            <span
                                                className="min-w-0 truncate text-xs font-normal text-muted-foreground"
                                                title={detail}
                                            >
                                                {detail}
                                            </span>
                                        ) : null}
                                    </DropdownMenuLabel>
                                    {group.source.readiness === "missing" ? (
                                        <p className="px-2 pb-1 text-xs text-muted-foreground">
                                            {t("code.notSignedIn")}
                                        </p>
                                    ) : null}
                                    {group.models.map((row) => (
                                        <DropdownMenuItem
                                            key={row.model.model ?? "default"}
                                            onSelect={() => pick(group.source, row.model)}
                                        >
                                            <span className="min-w-0 truncate" title={row.name}>
                                                {row.name}
                                            </span>
                                            <Mark on={same(value, group.source.key, row.model.model)} />
                                        </DropdownMenuItem>
                                    ))}
                                </div>
                            );
                        })}
                        {more ? (
                            <MoreModels
                                onMore={() => setLimit((current) => current + MODELS_PAGE)}
                                label={t("picker.more")}
                            />
                        ) : null}
                        {searching ? null : (
                            <>
                                <DropdownMenuSeparator />
                                {ordered.length > 1 ? (
                                    <DropdownMenuItem
                                        onSelect={(event) => {
                                            event.preventDefault();
                                            setOrdering(true);
                                        }}
                                    >
                                        <ArrowDownUp className="size-3.5 shrink-0" aria-hidden />
                                        {t("picker.order")}
                                    </DropdownMenuItem>
                                ) : null}
                                <DropdownMenuItem asChild>
                                    <Link href="/account/ai-keys">{t("picker.manage")}</Link>
                                </DropdownMenuItem>
                            </>
                        )}
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
