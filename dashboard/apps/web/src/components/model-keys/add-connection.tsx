"use client";

/**
 * Add connection: pick what to connect, then how - the "add an integration"
 * flow Places' Connect a device uses, with the same catalogue and the same cards
 * (`CatalogList`, `ChoiceCard` in @polaris/ui).
 *
 * Anthropic offers a key and an agent account, xAI a key and a SuperGrok sign-in,
 * Bedrock a cloud account, Cursor its own sign-in - one catalogue for all of
 * them, grouped by who makes it and narrowed by what kind of thing it is.
 *
 * It paints at once. The plans, clouds and agents are already on the page, and
 * the providers the table names are too; the rest of the provider catalogue
 * (thousands, paged by the server) arrives into its own region under them, and
 * a page already read in this tab is drawn from memory while it is asked again.
 * Typing filters what is on screen through a deferred value, so a keystroke
 * never waits on the list, and the server is asked once the typing settles.
 */

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { IntegrationLogo } from "@/components/logos";
import type { ProviderReader } from "./provider-select";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import { useConnectionHub, vendorKey, type ConnectionMethod, type ConnectionOption } from "./connection-hub";
import {
    Button,
    CatalogList,
    CatalogPicked,
    ChoiceCard,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    foldSearch,
    SearchField,
    SegmentedControl,
    Skeleton,
    type CatalogEntry
} from "@polaris/ui";

/** One way into one group, with the provider row a key opens on. */
interface Way {
    option: ConnectionOption;
    row?: ProviderRow;
}

/** Everything one maker offers. */
export interface ConnectionGroup {
    key: string;
    name: string;
    logo: string;
    ways: Way[];
}

/** The order ways are offered in: the plan somebody already pays for first. */
const METHOD_ORDER: readonly ConnectionMethod[] = ["login", "account", "home", "cloud", "key"];

/** The catalogue's filters, as Places and Home Assistant split theirs. */
export type ConnectionCategory = "all" | "providers" | "subscriptions" | "clouds" | "agents";
const CATEGORIES: readonly ConnectionCategory[] = ["all", "providers", "subscriptions", "clouds", "agents"];
const CATEGORY_OF: Record<ConnectionMethod, ConnectionCategory> = {
    key: "providers",
    login: "subscriptions",
    account: "subscriptions",
    cloud: "clouds",
    home: "agents"
};

type KindFilter = "all" | "lab" | "host" | "gateway" | "listed" | "custom";
const KINDS: readonly KindFilter[] = ["all", "lab", "host", "gateway", "listed", "custom"];
type FreeFilter = "all" | "any";

/**
 * Group the hub's ways and the catalogue's providers by maker. A provider row is
 * grouped under its own slug, a sign-in or cloud under the slug it opens, and an
 * agent account under the provider whose name matches its vendor - so a Claude
 * subscription sits beside the Anthropic key. Pure.
 */
export function groupConnections(options: readonly ConnectionOption[], rows: readonly ProviderRow[]): ConnectionGroup[] {
    const groups = new Map<string, ConnectionGroup>();
    const byVendor = new Map<string, string>();
    const add = (key: string, name: string, logo: string, way: Way) => {
        const group = groups.get(key) ?? { key, name, logo, ways: [] };
        if (!group.ways.some((one) => one.option.method === way.option.method && one.option.slug === way.option.slug))
            group.ways.push(way);
        groups.set(key, group);
        byVendor.set(vendorKey(group.name), key);
    };
    for (const row of rows) {
        add(row.slug, row.name, row.slug, {
            option: { method: "key", slug: row.slug, name: row.name, vendor: row.name, aliases: row.aliases },
            row
        });
    }
    for (const option of options.filter((one) => one.method === "login" || one.method === "cloud")) {
        const into = groups.get(option.slug);
        add(option.slug, into?.name ?? option.name, option.slug, { option });
    }
    for (const option of options.filter((one) => one.method === "account" || one.method === "home")) {
        const into = byVendor.get(vendorKey(option.vendor));
        if (into) add(into, groups.get(into)!.name, groups.get(into)!.logo, { option });
        else add(`${option.method}:${option.slug}`, option.name, option.slug, { option });
    }
    for (const group of groups.values())
        group.ways.sort((a, b) => METHOD_ORDER.indexOf(a.option.method) - METHOD_ORDER.indexOf(b.option.method));
    return [...groups.values()];
}

/** Whether a typed search finds a way: every word somewhere in its names, case
 *  and accents aside, as the Places catalogue matches. Pure. */
export function matchesConnection(option: ConnectionOption, query: string): boolean {
    const words = foldSearch(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const haystack = foldSearch([option.name, option.vendor, ...(option.aliases ?? [])].join(" "));
    return words.every((word) => haystack.includes(word));
}

/** Whether a group has a way of the category picked. Pure. */
export function inCategory(group: ConnectionGroup, category: ConnectionCategory): boolean {
    return category === "all" || group.ways.some((way) => CATEGORY_OF[way.option.method] === category);
}

/** Pages of the provider catalogue read in this tab, by query and filter, so
 *  reopening the dialog or going back to a filter draws at once. */
const pageCache = new Map<string, { items: ProviderRow[]; next: string | null }>();
const CACHE_LIMIT = 50;

function remember(key: string, page: { items: ProviderRow[]; next: string | null }) {
    pageCache.delete(key);
    pageCache.set(key, page);
    if (pageCache.size > CACHE_LIMIT) pageCache.delete(pageCache.keys().next().value!);
}

export function AddConnectionDialog({
    searchProviders,
    providers,
    onClose
}: {
    /** The key catalogue, paged from the server. */
    searchProviders?: ProviderReader;
    /** The rows the table already knows, drawn before the catalogue answers. */
    providers: readonly ProviderRow[];
    onClose: () => void;
}) {
    const t = useTranslations("components");
    const hub = useConnectionHub();
    const [query, setQuery] = useState("");
    const typed = useDeferredValue(query);
    const [category, setCategory] = useState<ConnectionCategory>("all");
    const [kind, setKind] = useState<KindFilter>("all");
    const [free, setFree] = useState<FreeFilter>("all");
    // The kind and cost filters are the provider catalogue's, so only that
    // category applies them.
    const providerKind = category === "providers" ? kind : "all";
    const providerFree = category === "providers" ? free : "all";
    const scope = `${typed.trim()}|${providerKind}|${providerFree}`;
    const [page, setPage] = useState(() => pageCache.get(scope) ?? null);
    const [pageScope, setPageScope] = useState(scope);
    const [loading, setLoading] = useState(Boolean(searchProviders));
    const [failed, setFailed] = useState(false);
    const [chosen, setChosen] = useState<ConnectionGroup | null>(null);
    const [way, setWay] = useState<Way | null>(null);
    const wantsProviders = category === "all" || category === "providers";
    const filtered = providerKind !== "all" || providerFree !== "all";

    if (pageScope !== scope) {
        setPageScope(scope);
        setPage(pageCache.get(scope) ?? null);
    }

    // The catalogue, asked once typing settles; whatever this tab already read
    // for the same search stays on screen meanwhile.
    useEffect(() => {
        if (!searchProviders || !wantsProviders) return;
        let live = true;
        const [text, k, f] = scope.split("|");
        const timer = setTimeout(
            () => {
                setLoading(true);
                setFailed(false);
                searchProviders({ query: text, kind: k === "all" ? null : k, free: f === "all" ? null : f })
                    .then((answer) => {
                        if (!live) return;
                        if ("error" in answer) {
                            setFailed(true);
                            return;
                        }
                        remember(scope, answer);
                        setPage(answer);
                    })
                    .catch(() => {
                        if (live) setFailed(true);
                    })
                    .finally(() => {
                        if (live) setLoading(false);
                    });
            },
            pageCache.has(scope) ? 0 : 200
        );
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [scope, searchProviders, wantsProviders]);

    async function more() {
        if (!searchProviders || !page?.next) return;
        const [text, k, f] = scope.split("|");
        const answer = await searchProviders({
            query: text,
            cursor: page.next,
            kind: k === "all" ? null : k,
            free: f === "all" ? null : f
        }).catch(() => null);
        if (!answer || "error" in answer) return;
        const merged = { items: [...page.items, ...answer.items], next: answer.next };
        remember(scope, merged);
        setPage(merged);
    }

    const options = hub?.options;
    // The rows known before the catalogue answers: the table's own, narrowed
    // here; the catalogue's narrowing is the server's.
    const rows = useMemo(() => {
        if (!wantsProviders) return [];
        const known = filtered
            ? []
            : providers.filter((row) =>
                  matchesConnection({ method: "key", slug: row.slug, name: row.name, vendor: row.name, aliases: row.aliases }, typed)
              );
        const seen = new Set(known.map((row) => row.slug));
        return [...known, ...(page?.items ?? []).filter((row) => !seen.has(row.slug))];
    }, [wantsProviders, filtered, providers, typed, page]);

    const groups = useMemo(() => {
        const matching = filtered ? [] : (options ?? []).filter((option) => matchesConnection(option, typed));
        // What is not a key comes first: there are a handful of them, and they
        // are what somebody is most often here for.
        return groupConnections(matching, rows)
            .filter((group) => inCategory(group, category))
            .sort((a, b) => Number(isKeyOnly(a)) - Number(isKeyOnly(b)));
    }, [options, typed, rows, category, filtered]);

    const entries = useMemo<CatalogEntry[]>(
        () =>
            groups.map((group) => ({
                key: group.key,
                logo: <IntegrationLogo slug={group.logo} name={group.name} className="size-6 shrink-0 object-contain" />,
                title: group.name,
                tags: [...new Set(group.ways.map((one) => t(`modelKeys.connect.short.${one.option.method}`)))]
            })),
        [groups, t]
    );
    const byKey = useMemo(() => new Map(groups.map((group) => [group.key, group])), [groups]);

    function start(picked: Way) {
        onClose();
        hub?.open(picked.option.method, picked.option.slug, picked.row);
    }

    function pick(key: string) {
        const group = byKey.get(key);
        if (!group) return;
        if (group.ways.length === 1) return start(group.ways[0]!);
        setChosen(group);
        setWay(group.ways[0]!);
    }

    const waiting = wantsProviders && Boolean(searchProviders) && loading && !page;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="flex max-h-[85vh] w-full max-w-xl flex-col gap-3 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>
                        {chosen ? t("modelKeys.connect.howTitle", { name: chosen.name }) : t("modelKeys.connect.title")}
                    </DialogTitle>
                    <DialogDescription>
                        {chosen ? t("modelKeys.connect.howHint") : t("modelKeys.connect.hint")}
                    </DialogDescription>
                </DialogHeader>
                {chosen ? (
                    <>
                        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain">
                            <CatalogPicked
                                logo={<IntegrationLogo slug={chosen.logo} name={chosen.name} className="size-6 shrink-0 object-contain" />}
                                title={chosen.name}
                                action={
                                    <Button variant="ghost" size="sm" onClick={() => setChosen(null)}>
                                        {t("modelKeys.connect.change")}
                                    </Button>
                                }
                            />
                            <div className="flex flex-col gap-1.5">
                                <span className="text-xs text-muted-foreground">{t("modelKeys.connect.how")}</span>
                                <div className="flex flex-col gap-2">
                                    {chosen.ways.map((one) => (
                                        <ChoiceCard
                                            key={`${one.option.method}:${one.option.slug}`}
                                            selected={one === way}
                                            onSelect={() => setWay(one)}
                                            logo={<IntegrationLogo slug={one.option.slug} name={one.option.name} className="size-4 shrink-0 object-contain" />}
                                            title={<span className="min-w-0 truncate">{wayLabel(t, one)}</span>}
                                            summary={t(`modelKeys.connect.methods.${one.option.method}`)}
                                        />
                                    ))}
                                </div>
                            </div>
                        </div>
                        <DialogFooter>
                            <Button variant="ghost" onClick={onClose}>
                                {t("modelKeys.cancel")}
                            </Button>
                            <Button disabled={!way} onClick={() => way && start(way)}>
                                {t("modelKeys.connect.continue")}
                            </Button>
                        </DialogFooter>
                    </>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-2">
                        <SearchField
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== "Enter" || !entries[0]) return;
                                event.preventDefault();
                                pick(entries[0].key);
                            }}
                            placeholder={t("modelKeys.connect.search")}
                            aria-label={t("modelKeys.connect.search")}
                            maxLength={200}
                        />
                        <div className="min-w-0 max-w-full overflow-x-auto">
                            <SegmentedControl<ConnectionCategory>
                                size="sm"
                                value={category}
                                onValueChange={setCategory}
                                aria-label={t("modelKeys.connect.categoryLabel")}
                                options={CATEGORIES.map((value) => ({
                                    value,
                                    label: t(`modelKeys.connect.categories.${value}`)
                                }))}
                            />
                        </div>
                        {category === "providers" ? (
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                <div className="min-w-0 max-w-full overflow-x-auto">
                                    <SegmentedControl<KindFilter>
                                        size="sm"
                                        value={kind}
                                        onValueChange={setKind}
                                        aria-label={t("providerSelect.kindLabel")}
                                        options={KINDS.map((value) => ({ value, label: t(`providerSelect.kind.${value}`) }))}
                                    />
                                </div>
                                <SegmentedControl<FreeFilter>
                                    size="sm"
                                    value={free}
                                    onValueChange={setFree}
                                    aria-label={t("providerSelect.freeLabel")}
                                    options={[
                                        { value: "all", label: t("providerSelect.kind.all") },
                                        { value: "any", label: t("providerSelect.freeOnly") }
                                    ]}
                                />
                            </div>
                        ) : null}
                        <CatalogList
                            label={t("modelKeys.connect.title")}
                            className="flex-1"
                            entries={entries}
                            onPick={pick}
                            empty={
                                waiting
                                    ? undefined
                                    : failed && wantsProviders
                                      ? t("modelKeys.connect.failed")
                                      : t("modelKeys.connect.none")
                            }
                            footer={
                                waiting ? (
                                    <div aria-label={t("modelKeys.connect.loading")} className="flex flex-col gap-1 px-2 py-2">
                                        {[0, 1, 2, 3].map((index) => (
                                            <div key={index} className="flex items-center gap-3 py-1">
                                                <Skeleton className="size-6 shrink-0 rounded" />
                                                <Skeleton className="h-4 w-40" />
                                            </div>
                                        ))}
                                    </div>
                                ) : page?.next && wantsProviders ? (
                                    <Button variant="ghost" size="sm" className="self-start" onClick={() => void more()}>
                                        {t("modelKeys.connect.more")}
                                    </Button>
                                ) : null
                            }
                        />
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function isKeyOnly(group: ConnectionGroup): boolean {
    return group.ways.every((one) => one.option.method === "key");
}

function wayLabel(t: NamespaceTranslator<"components">, one: Way): string {
    switch (one.option.method) {
        case "key":
            return t("modelKeys.connect.ways.key", { name: one.option.name });
        case "login":
            return t("modelKeys.connect.ways.login", { name: one.option.name });
        case "cloud":
            return t("modelKeys.connect.ways.cloud", { name: one.option.name });
        default:
            return one.option.name;
    }
}
