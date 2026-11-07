"use client";

/**
 * "Does it work on my TV?": the three tiers, a search over every TV somebody
 * ran the launcher on, and, for a TV that is not listed, the answer its
 * Settings > About screen gives. One component for the public Downloads page,
 * the docs and the dashboard's install dialog; the words come from the
 * `tvCompat` catalog of whichever one draws it.
 */

import { Badge } from "../components/badge";
import { Input } from "../components/input";
import * as tv from "@polaris/core/tv-compat";
import { Button } from "../components/button";
import { Select } from "../components/select";
import { useLocale, useTranslations } from "../i18n";
import { useMemo, useState, type ReactNode } from "react";
import { AppWindow, Check, ExternalLink, House, Router, Search } from "lucide-react";

/** The guides a result can point at. */
export type TvGuide = "setup" | "fire" | "network" | "privacy";

/** Each guide's page on the docs site. */
export const TV_GUIDE_SLUGS: Readonly<Record<TvGuide, string>> = {
    setup: "polaris-tv-setup",
    fire: "polaris-tv-fire",
    network: "polaris-tv-network",
    privacy: "polaris-tv-privacy"
};

/** The public docs, for a screen that is not the docs site itself. */
const PUBLIC_DOCS = "https://fjrg2007.github.io/polaris";
/** Models drawn at first and added per "Show more". */
const PAGE = 24;
/** Brand chips shown beside "All"; the search reaches every other brand. */
const BRAND_CHIPS = 14;

const TIER_GUIDE: Readonly<Record<tv.TvTier, TvGuide>> = {
    full: "setup",
    app: "fire",
    network: "network"
};
const TIER_BADGE = { full: "success", app: "primary", network: "neutral" } as const;
const TIER_ICON = { full: House, app: AppWindow, network: Router } as const;

export function publicGuideHref(locale: string, guide: TvGuide): string {
    const lang = locale.startsWith("es") ? "es" : "en";
    return `${PUBLIC_DOCS}/${lang}/docs/${TV_GUIDE_SLUGS[guide]}/`;
}

function useDate() {
    const locale = useLocale();
    return useMemo(() => {
        const format = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
        return (date: string) => format.format(new Date(`${date}T00:00:00Z`));
    }, [locale]);
}

interface Links {
    readonly guideHref: (guide: TvGuide) => string;
    readonly action?: (tier: tv.TvTier) => ReactNode;
}

function GuideLink({ href, children }: { href: string; children: ReactNode }) {
    // The public docs open beside a screen that is not the docs site, so a dialog is not lost.
    const away = /^https?:/.test(href);
    return (
        <a
            href={href}
            target={away ? "_blank" : undefined}
            rel={away ? "noreferrer" : undefined}
            className="inline-flex min-w-0 items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
        >
            <span className="min-w-0 truncate">{children}</span>
        </a>
    );
}

function Quirks({ ids }: { ids: readonly tv.TvQuirkId[] }) {
    const t = useTranslations("tvCompat");
    if (ids.length === 0) return null;
    return (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {ids.map((id) => {
                const source = tv.quirkSource(id);
                return (
                    <li key={id} className="min-w-0 break-words">
                        {t(`quirks.${id}`)}{" "}
                        {source ? (
                            <a
                                href={source}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-0.5 text-xs underline"
                            >
                                {t("model.source")}
                                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
                            </a>
                        ) : null}
                    </li>
                );
            })}
        </ul>
    );
}

function TierBadge({ tier }: { tier: tv.TvTier }) {
    const t = useTranslations("tvCompat");
    const Icon = TIER_ICON[tier];
    return (
        <Badge variant={TIER_BADGE[tier]}>
            <Icon className="size-3 shrink-0" aria-hidden="true" />
            {t(`tiers.${tier}.name`)}
        </Badge>
    );
}

function TierCards() {
    const t = useTranslations("tvCompat");
    return (
        <ul className="grid gap-3 sm:grid-cols-3">
            {tv.TV_TIERS.map((tier) => (
                <li
                    key={tier}
                    className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border p-3"
                >
                    <TierBadge tier={tier} />
                    <p className="text-sm">{t(`tiers.${tier}.summary`)}</p>
                    <p className="text-xs text-muted-foreground">{t(`tiers.${tier}.rule`)}</p>
                </li>
            ))}
        </ul>
    );
}

function ModelRow({ model, links }: { model: tv.TvModel; links: Links }) {
    const t = useTranslations("tvCompat");
    const date = useDate();
    const privacy = tv.privacyFor(model);
    return (
        <li className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <p className="min-w-0 break-words font-medium">
                    {model.model.toLowerCase().startsWith(model.brand.toLowerCase())
                        ? model.model
                        : `${model.brand} ${model.model}`}
                </p>
                <TierBadge tier={model.tier} />
            </div>
            <p className="text-sm text-muted-foreground">
                {t("model.os")}: {t(`platforms.${model.platform}`)}
                {model.osVersion ? ` ${model.osVersion}` : ` (${t("model.osUnknown")})`}
            </p>
            <Quirks ids={model.quirks} />
            <p className="text-xs text-muted-foreground">
                {t(`model.${model.tested.by}`, { date: date(model.tested.date) })}{" "}
                <a href={model.source} target="_blank" rel="noreferrer" className="underline">
                    {t("model.source")}
                </a>
            </p>
            <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                <GuideLink href={links.guideHref(TIER_GUIDE[model.tier])}>
                    {t(`guides.${TIER_GUIDE[model.tier]}`)}
                </GuideLink>
                {privacy.length ? (
                    <GuideLink href={`${links.guideHref("privacy")}#${privacy[0]!.id}`}>
                        {t("model.privacy")}
                    </GuideLink>
                ) : null}
                {links.action?.(model.tier)}
            </div>
        </li>
    );
}

/** The answer for a TV that is not listed, from what its About screen says. */
export function TvMissing({ links }: { links: Links }) {
    const t = useTranslations("tvCompat");
    const [platform, setPlatform] = useState<tv.TvPlatform>("android-tv");
    const [version, setVersion] = useState("");
    const ruling = tv.tierFor(platform, version.trim() || null);
    const guide = TIER_GUIDE[ruling.tier];
    return (
        <section
            aria-labelledby="tv-missing-title"
            className="flex min-w-0 flex-col gap-3 rounded-lg border border-dashed border-border p-3"
        >
            <h3 id="tv-missing-title" className="font-medium">
                {t("missing.title")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("missing.intro")}</p>
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_8rem]">
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("missing.platform")}
                    <Select
                        aria-label={t("missing.platform")}
                        value={platform}
                        onValueChange={(next) => setPlatform(next as tv.TvPlatform)}
                        options={tv.TV_PLATFORMS.map((value) => ({
                            value,
                            label: t(`platforms.${value}`)
                        }))}
                    />
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-sm">
                    {t("missing.version")}
                    <Input
                        inputMode="decimal"
                        value={version}
                        placeholder={t("missing.versionPlaceholder")}
                        onChange={(event) => setVersion(event.target.value.slice(0, 16))}
                    />
                </label>
            </div>
            <div role="status" className="flex min-w-0 flex-col gap-2">
                <p className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    {t("missing.answer")} <TierBadge tier={ruling.tier} />
                </p>
                <p className="text-sm">{t(`tiers.${ruling.tier}.summary`)}</p>
                <Quirks ids={ruling.quirks} />
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                    <GuideLink href={links.guideHref(guide)}>{t(`guides.${guide}`)}</GuideLink>
                    <GuideLink href={links.guideHref("privacy")}>{t("guides.privacy")}</GuideLink>
                    {links.action?.(ruling.tier)}
                </div>
            </div>
        </section>
    );
}

export function TvChecker({
    guideHref,
    action,
    initialQuery = "",
    heading = true
}: {
    /** Where a guide opens; the public docs when left out. */
    guideHref?: (guide: TvGuide) => string;
    /** Drawn beside a result or an answer, such as an install button for a tier that has one. */
    action?: (tier: tv.TvTier) => ReactNode;
    initialQuery?: string;
    /** Whether the title and the tier cards are drawn above the search. */
    heading?: boolean;
}) {
    const t = useTranslations("tvCompat");
    const locale = useLocale();
    const [query, setQuery] = useState(initialQuery);
    const [brand, setBrand] = useState<string | null>(null);
    const [shown, setShown] = useState(PAGE);
    const brands = useMemo(() => tv.tvBrandCounts(tv.TV_MODELS).slice(0, BRAND_CHIPS), []);
    const found = useMemo(() => tv.searchTvModels(tv.TV_MODELS, query, { brand }), [query, brand]);
    const links: Links = {
        guideHref: guideHref ?? ((guide) => publicGuideHref(locale, guide)),
        action
    };
    const pick = (next: string | null) => {
        setBrand(next);
        setShown(PAGE);
    };

    return (
        <div className="flex min-w-0 flex-col gap-4">
            {heading ? (
                <>
                    <div className="flex min-w-0 flex-col gap-1">
                        <h2 className="text-xl font-semibold tracking-tight">{t("title")}</h2>
                        <p className="text-sm text-muted-foreground">{t("intro")}</p>
                    </div>
                    <TierCards />
                </>
            ) : null}
            <div className="flex min-w-0 flex-col gap-2">
                <label htmlFor="tv-compat-search" className="text-sm font-medium">
                    {t("search.label")}
                </label>
                <div className="relative min-w-0">
                    <Search
                        className="pointer-events-none absolute left-2.5 top-1/2 size-4 shrink-0 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        id="tv-compat-search"
                        type="search"
                        className="pl-8"
                        value={query}
                        placeholder={t("search.placeholder")}
                        onChange={(event) => {
                            setQuery(event.target.value.slice(0, 120));
                            setShown(PAGE);
                        }}
                    />
                </div>
                <div
                    role="group"
                    aria-label={t("search.brands")}
                    className="flex min-w-0 flex-wrap gap-1.5"
                >
                    {[{ brand: null, count: tv.TV_MODELS.length }, ...brands].map((chip) => {
                        const on = brand === chip.brand;
                        return (
                            <button
                                key={chip.brand ?? ""}
                                type="button"
                                aria-pressed={on}
                                onClick={() => pick(on ? null : chip.brand)}
                                className={`inline-flex min-w-0 max-w-full items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs ${
                                    on
                                        ? "border-primary bg-primary/15 text-primary"
                                        : "border-border text-muted-foreground hover:text-foreground"
                                }`}
                            >
                                {on ? (
                                    <Check className="size-3 shrink-0" aria-hidden="true" />
                                ) : null}
                                <span className="truncate">
                                    {chip.brand ?? t("search.allBrands")}
                                </span>
                                <span className="tabular-nums">{chip.count}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
            <section aria-label={t("search.results")} className="flex min-w-0 flex-col gap-2">
                <p role="status" className="text-xs text-muted-foreground">
                    {t("search.count", { count: found.length })}
                </p>
                {found.length ? (
                    <ul className="grid min-w-0 gap-2 lg:grid-cols-2">
                        {found.slice(0, shown).map((model) => (
                            <ModelRow key={model.id} model={model} links={links} />
                        ))}
                    </ul>
                ) : null}
                {found.length > shown ? (
                    <div className="flex min-w-0 flex-wrap items-center gap-3">
                        <Button variant="outline" onClick={() => setShown(shown + PAGE)}>
                            {t("search.showMore")}
                        </Button>
                        <span className="text-xs text-muted-foreground">
                            {t("search.shown", { shown, total: found.length })}
                        </span>
                    </div>
                ) : null}
            </section>
            <TvMissing links={links} />
        </div>
    );
}

/** Every brand's privacy switches, as the docs page draws them. */
export function TvPrivacyGuide() {
    const t = useTranslations("tvCompat");
    const date = useDate();
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <p className="text-sm text-muted-foreground">
                {t("privacy.read", { date: date(tv.TV_PRIVACY.read) })}
            </p>
            {tv.TV_PRIVACY.brands.map((entry) => (
                <section
                    key={entry.id}
                    id={entry.id}
                    className="flex min-w-0 scroll-mt-20 flex-col gap-2"
                >
                    <h3 className="font-medium">{entry.brand}</h3>
                    <dl className="flex min-w-0 flex-col gap-2">
                        {entry.steps.map((step) => (
                            <div
                                key={step.path + step.action}
                                className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border p-2"
                            >
                                <dt className="sr-only">{t("privacy.setting")}</dt>
                                <dd className="break-words font-mono text-xs">{step.path}</dd>
                                <dt className="sr-only">{t("privacy.action")}</dt>
                                <dd className="break-words text-sm">{step.action}</dd>
                            </div>
                        ))}
                    </dl>
                    <a
                        href={entry.source}
                        target="_blank"
                        rel="noreferrer"
                        className="self-start text-xs text-muted-foreground underline"
                    >
                        {t("privacy.source")}
                    </a>
                </section>
            ))}
        </div>
    );
}
