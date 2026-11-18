"use client";

/**
 * Add connection: pick what to connect, then how. Anthropic offers a key and an
 * agent account, xAI a key and a SuperGrok sign-in, Bedrock a cloud account,
 * Cursor its own sign-in - one list for all of them, grouped by who makes it, so
 * nobody has to know which card a way in used to live on.
 */

import { useEffect, useMemo, useState } from "react";
import { IntegrationLogo } from "@/components/logos";
import type { ProviderReader } from "./provider-select";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import { useConnectionHub, vendorKey, type ConnectionMethod, type ConnectionOption } from "./connection-hub";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input } from "@polaris/ui";

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

/** Whether a typed search finds a way, by any of its names. Pure. */
export function matchesConnection(option: ConnectionOption, query: string): boolean {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return true;
    return [option.name, option.vendor, ...(option.aliases ?? [])].some((word) => word.toLowerCase().includes(wanted));
}

export function AddConnectionDialog({
    searchProviders,
    providers,
    onClose
}: {
    /** The key catalogue, paged from the server. */
    searchProviders?: ProviderReader;
    /** The rows the table already knows, used where there is no search. */
    providers: readonly ProviderRow[];
    onClose: () => void;
}) {
    const t = useTranslations("components");
    const hub = useConnectionHub();
    const [query, setQuery] = useState("");
    const [rows, setRows] = useState<ProviderRow[] | null>(searchProviders ? null : [...providers]);
    const [next, setNext] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const [chosen, setChosen] = useState<ConnectionGroup | null>(null);

    // The catalogue is read as somebody types, the last answer winning.
    useEffect(() => {
        if (!searchProviders) {
            setRows(providers.filter((row) => matchesConnection({ method: "key", slug: row.slug, name: row.name, vendor: row.name, aliases: row.aliases }, query)));
            return;
        }
        let live = true;
        const timer = setTimeout(() => {
            setRows(null);
            setFailed(false);
            searchProviders({ query })
                .then((page) => {
                    if (!live) return;
                    if ("error" in page) {
                        setFailed(true);
                        setRows([]);
                        return;
                    }
                    setRows(page.items);
                    setNext(page.next);
                })
                .catch(() => {
                    if (live) {
                        setFailed(true);
                        setRows([]);
                    }
                });
        }, 200);
        return () => {
            live = false;
            clearTimeout(timer);
        };
    }, [query, searchProviders, providers]);

    async function more() {
        if (!searchProviders || next === null) return;
        const page = await searchProviders({ query, cursor: next }).catch(() => null);
        if (!page || "error" in page) return;
        setRows((current) => [...(current ?? []), ...page.items]);
        setNext(page.next);
    }

    const options = hub?.options ?? [];
    const groups = useMemo(
        () => groupConnections(options.filter((option) => matchesConnection(option, query)), rows ?? []),
        [options, query, rows]
    );
    // The ways that are not a key come first: there are a handful of them, and
    // they are what this screen used to show as cards before the catalogue.
    const ordered = useMemo(
        () => [...groups].sort((a, b) => Number(isKeyOnly(a)) - Number(isKeyOnly(b))),
        [groups]
    );

    function start(way: Way) {
        onClose();
        hub?.open(way.option.method, way.option.slug, way.row);
    }

    function pick(group: ConnectionGroup) {
        if (group.ways.length === 1) start(group.ways[0]!);
        else setChosen(group);
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="flex max-h-[85vh] max-w-lg flex-col gap-3 overflow-hidden">
                <DialogHeader>
                    <DialogTitle>{chosen ? t("modelKeys.connect.howTitle", { name: chosen.name }) : t("modelKeys.connect.title")}</DialogTitle>
                    <DialogDescription>{chosen ? t("modelKeys.connect.howHint") : t("modelKeys.connect.hint")}</DialogDescription>
                </DialogHeader>
                {chosen ? (
                    <div className="flex min-h-0 flex-col gap-2">
                        <ul className="flex flex-col gap-1.5">
                            {chosen.ways.map((way) => (
                                <li key={`${way.option.method}:${way.option.slug}`}>
                                    <button
                                        type="button"
                                        className="flex w-full min-w-0 items-center gap-3 rounded-md border border-border px-3 py-2 text-start hover:bg-surface"
                                        onClick={() => start(way)}
                                    >
                                        <IntegrationLogo slug={way.option.slug} name={way.option.name} className="size-5 shrink-0" />
                                        <span className="flex min-w-0 flex-1 flex-col">
                                            <span className="truncate text-sm font-medium" title={wayLabel(t, way)}>
                                                {wayLabel(t, way)}
                                            </span>
                                            <span className="truncate text-xs text-muted-foreground">
                                                {t(`modelKeys.connect.methods.${way.option.method}`)}
                                            </span>
                                        </span>
                                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                        <Button variant="ghost" size="sm" className="self-start" onClick={() => setChosen(null)}>
                            <ChevronLeft className="size-4 shrink-0" />
                            {t("modelKeys.connect.back")}
                        </Button>
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-col gap-2">
                        <Input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("modelKeys.connect.search")}
                            aria-label={t("modelKeys.connect.search")}
                        />
                        <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1">
                            {ordered.map((group) => (
                                <li key={group.key}>
                                    <button
                                        type="button"
                                        className="flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-start hover:bg-surface"
                                        onClick={() => pick(group)}
                                    >
                                        <IntegrationLogo slug={group.logo} name={group.name} className="size-5 shrink-0" />
                                        <span className="min-w-0 flex-1 truncate text-sm" title={group.name}>
                                            {group.name}
                                        </span>
                                        <span className="flex shrink-0 gap-1">
                                            {[...new Set(group.ways.map((way) => way.option.method))].map((method) => (
                                                <span key={method} className="rounded bg-surface px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                                                    {t(`modelKeys.connect.short.${method}`)}
                                                </span>
                                            ))}
                                        </span>
                                    </button>
                                </li>
                            ))}
                            {rows === null ? (
                                <li className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                                    <Loader2 className="size-3.5 shrink-0 animate-spin" />
                                    {t("modelKeys.connect.loading")}
                                </li>
                            ) : null}
                            {rows !== null && ordered.length === 0 ? (
                                <li className="px-2 py-1.5 text-xs text-muted-foreground">
                                    {failed ? t("modelKeys.connect.failed") : t("modelKeys.connect.none")}
                                </li>
                            ) : null}
                        </ul>
                        {next !== null && rows !== null ? (
                            <Button variant="ghost" size="sm" className="self-start" onClick={() => void more()}>
                                {t("modelKeys.connect.more")}
                            </Button>
                        ) : null}
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

function isKeyOnly(group: ConnectionGroup): boolean {
    return group.ways.every((way) => way.option.method === "key");
}

function wayLabel(t: NamespaceTranslator<"components">, way: Way): string {
    switch (way.option.method) {
        case "key":
            return t("modelKeys.connect.ways.key", { name: way.option.name });
        case "login":
            return t("modelKeys.connect.ways.login", { name: way.option.name });
        case "cloud":
            return t("modelKeys.connect.ways.cloud", { name: way.option.name });
        default:
            return way.option.name;
    }
}
