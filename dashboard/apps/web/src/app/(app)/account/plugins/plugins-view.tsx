"use client";

/**
 * Device plugins: the store (Browse / Installed / Updates, search and
 * categories) and each plugin's own page, drawn from what the desktop app
 * answers (`lib/device-plugins-client`). Built from the marketplace's own store
 * pieces (`@polaris/ui/store-card`, `store-layout`), so it reads as the same
 * store. A plugin's settings are its manifest's declarative list, drawn with
 * Polaris's own controls - no plugin markup reaches this page.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatBytes, initialsInk, tintFor } from "@polaris/core";
import { Loader2, Package, Trash2 } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { StoreCard, StatusBadge, StorePreview } from "@polaris/ui/store-card";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { OverflowMenu, StoreCardSkeletons, StoreFilters, StoreNoMatch, StoreSection, type OverflowEntry } from "@polaris/ui/store-layout";
import {
    Badge,
    Button,
    cn,
    ControlSlider,
    SegmentedControl,
    Select,
    settingType,
    Skeleton,
    Switch,
    useToast
} from "@polaris/ui";
import {
    PLUGIN_ACTIONS,
    PLUGIN_CATEGORIES,
    pluginReleases,
    pluginRequirements,
    pluginText,
    pluginGroupAnchor,
    pluginSettingAnchor,
    pluginSettingSections,
    readPluginSettingValues,
    readPluginsSnapshot,
    type PluginEntry,
    type PluginHostAction,
    type PluginManifest,
    type PluginSetting,
    type PluginSettingGroup,
    type PluginSettingValue,
    type PluginsSnapshot,
    type InstalledPlugin
} from "@polaris/core/device-plugins";
import {
    pluginListings,
    pluginOffer,
    usePlugins,
    usePluginSettings,
    changePluginSettings,
    keepPluginSettings,
    useInstallPlugin,
    statusDetail,
    PERMISSION_KEY,
    type PluginListing,
    type PluginOffer,
    type PluginsBridge,
    type PluginsState
} from "@/lib/device-plugins-client";
import { pageIsDark } from "@/lib/page-theme";
import { OfficialSoftware } from "./official-software";
import { PluginProfiles } from "./plugin-profiles";
import { PluginActions, useDeviceActionOptions } from "./plugin-actions";
import type { AppScreenshot } from "@/lib/apps/app-screenshots";
import { ScreenshotGallery } from "@/app/(app)/apps/marketplace/[appId]/screenshot-gallery";
import { DetailBack, DetailFacts, DetailHeader, DetailReleases, DetailSection, Fact } from "@/components/store-detail";
import { useOfficialChoice } from "./official-choice-dialog";
import { pluginViewHeight, pluginViewHello, pluginViewUrl, readPluginViewMessage, readPluginViewReply, watchPluginViewLook, PLUGIN_VIEW_HEIGHT } from "@/lib/device-plugin-view";

type Words = ReturnType<typeof useTranslations<"account">>;
type Tab = "browse" | "installed" | "updates";
type Category = "" | (typeof PLUGIN_CATEGORIES)[number];

/** The picker's list: `call.leave` reads as hang up, so it is offered once, as `call.hangup`. */
const PICKABLE_ACTIONS = PLUGIN_ACTIONS.filter((action) => action !== "call.leave");

function say(t: Words, key: string, values?: Record<string, string | number>): string {
    return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(`plugins.${key}`, values);
}

function manifestOf(listing: PluginListing): PluginManifest | null {
    return listing.entry ?? listing.installed?.manifest ?? null;
}

/** The badge's short word for how a plugin runs, and the sentence its plugin said about the device, if any. */
function runLabel(t: Words, installed: InstalledPlugin, entry: PluginEntry | null, locale: string): { status: string; label: string; detail?: string } {
    const run = installed.run;
    if ("status" in run && run.status && (run.state === "running" || run.state === "starting")) {
        const detail = statusDetail(run.status, [installed.manifest, entry], locale, (key, values) => say(t, key, values));
        return { status: run.status.state === "connected" ? "running" : run.status.state === "error" ? "failed" : "idle", label: say(t, `status.${run.status.state}`), detail };
    }
    return { status: run.state === "running" ? "running" : run.state === "failed" || run.state === "missing" ? "failed" : "idle", label: say(t, `status.${run.state}`) };
}

function PluginIcon({ entry, size }: { entry: PluginEntry | null; size: number }) {
    const t = useTranslations("account");
    if (entry?.icon) {
        return (
            // eslint-disable-next-line @next/next/no-img-element -- a release asset, cached by the browser
            <img src={entry.icon} alt={say(t, "card.icon", { name: entry.name })} width={size} height={size} loading="lazy" className="shrink-0 rounded-md" />
        );
    }
    return (
        <span className="grid shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" style={{ width: size, height: size }} aria-hidden>
            <Package style={{ width: size * 0.5, height: size * 0.5 }} />
        </span>
    );
}

/** The leading action for one plugin: install, its progress, update, configure, or why it cannot. */
function OfferButton({ offer, href, onInstall, size = "sm" }: { offer: PluginOffer; href: string; onInstall: () => void; size?: "sm" | "md" }) {
    const t = useTranslations("account");
    switch (offer.kind) {
        case "install":
            return (
                <Button size={size} onClick={onInstall}>
                    {say(t, "card.install")}
                </Button>
            );
        case "installing":
            return (
                <Button size={size} disabled aria-busy>
                    <Loader2 className="size-4 animate-spin" />
                    {offer.updating
                        ? offer.percent === null
                            ? say(t, "card.updating")
                            : say(t, "card.updatingPercent", { percent: offer.percent })
                        : offer.percent === null
                          ? say(t, "card.preparing")
                          : say(t, "card.installing", { percent: offer.percent })}
                </Button>
            );
        case "update":
            return (
                <Button size={size} onClick={onInstall}>
                    {say(t, "card.update", { version: offer.version })}
                </Button>
            );
        case "installed":
            return (
                <Button asChild size={size} variant="secondary">
                    <Link href={href}>{say(t, "card.open")}</Link>
                </Button>
            );
        case "unavailable":
            return (
                <Badge className="text-muted-foreground">
                    {offer.reason === "platform" ? say(t, "card.platform") : say(t, "card.appVersion", { version: offer.needs })}
                </Badge>
            );
    }
}

/**
 * Install with its permissions read out first; a failure is said in a toast.
 * An update reads out only what it asks for that was not accepted before, the
 * one thing an automatic update never decides for the person.
 */
function useInstallFlow(bridge: PluginsBridge | null, snapshot: PluginsSnapshot | null): [(entry: PluginEntry) => void, ReactNode] {
    const t = useTranslations("account");
    const locale = useLocale();
    const toast = useToast();
    const [confirm, element] = useConfirm();
    const install = useInstallPlugin(bridge);
    const platform = snapshot?.platform ?? null;
    const [offerOfficial, officialElement] = useOfficialChoice(bridge, platform);
    const start = (entry: PluginEntry) => {
        const installed = snapshot?.installed.find((item) => item.id === entry.id) ?? null;
        const updating = Boolean(installed?.update);
        const listed = updating ? entry.permissions.filter((permission) => !installed?.granted.includes(permission)) : entry.permissions;
        // What the platform sets up for it reads as one more line; an update lists only what it adds.
        const had = new Set(installed?.manifest ? pluginRequirements(installed.manifest, platform).map((item) => item.key) : []);
        const requires = pluginRequirements(entry, platform).filter((item) => !updating || !had.has(item.key));
        const asks = [
            ...listed.map((permission) => `- ${say(t, `permission.${PERMISSION_KEY[permission]}`)}`),
            ...requires.map((requirement) => `- ${pluginText(requirement.label, locale)}`)
        ];
        const lead = updating ? (asks.length > 0 ? say(t, "update.added") : say(t, "update.noNew")) : asks.length > 0 ? say(t, "install.asks") : say(t, "install.none");
        const description = [lead, ...asks, ""].join("\n");
        void (async () => {
            if (!updating && (await offerOfficial(entry))) return;
            const ok = await confirm(
                updating
                    ? { title: say(t, "update.title", { name: entry.name, version: entry.version }), description, confirmLabel: say(t, "update.confirm") }
                    : { title: say(t, "install.title", { name: entry.name }), description, confirmLabel: say(t, "install.confirm") }
            );
            if (!ok) return;
            const outcome = await install(entry, requires.map((item) => item.key));
            if (!outcome.installed) toast.show({ title: say(t, `failure.${outcome.problem === "app-version" ? "appVersion" : outcome.problem}`) });
            else if (!outcome.started) toast.show({ title: say(t, "failure.notStarted") });
        })();
    };
    return [
        start,
        <>
            {element}
            {officialElement}
        </>
    ];
}

function hrefOf(id: string): string {
    return `/account/plugins/${encodeURIComponent(id)}`;
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div className={cn(settingType.body, "flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-muted-foreground")}>
            <span className="min-w-0">{children}</span>
            {action}
        </div>
    );
}

function NotHere({ state }: { state: PluginsState }) {
    const t = useTranslations("account");
    if (state.kind === "browser") {
        return (
            <Notice
                action={
                    <Button asChild size="sm" variant="secondary">
                        <Link href="/account/downloads">{say(t, "page.download")}</Link>
                    </Button>
                }
            >
                {say(t, "page.browser")}
            </Notice>
        );
    }
    if (state.kind === "old-app") return <Notice>{say(t, "page.oldApp")}</Notice>;
    return null;
}

/** Uninstall one plugin, once the person confirms it in the page's own dialog. */
function useUninstall(bridge: PluginsBridge | null): [(id: string, name: string) => void, ReactNode] {
    const t = useTranslations("account");
    const toast = useToast();
    const [confirm, element] = useConfirm();
    const start = (id: string, name: string) => {
        void (async () => {
            const ok = await confirm({ title: say(t, "detail.uninstallTitle", { name }), description: say(t, "detail.uninstallBody"), confirmLabel: say(t, "detail.uninstall"), danger: true });
            if (!ok || !bridge) return;
            const done = await bridge.uninstall(id).catch(() => false);
            if (!done) toast.show({ title: say(t, "menu.uninstallFailed") });
        })();
    };
    return [start, element];
}

/**
 * The card's menu, as the Polaris apps' cards have it: the plugin's page, its
 * settings, the update, automatic updates, turning it off and uninstalling it.
 * Only what the desktop app can do; while it installs, what would race the
 * install is switched off with the reason. What the app offers to do for the
 * plugin (`InstalledPlugin.actions`) sits here too, as on the plugin's page.
 */
function pluginMenu(
    t: Words,
    {
        listing,
        snapshot,
        bridge,
        offer,
        href,
        name,
        locale,
        go,
        onInstall,
        onUninstall,
        onFailed
    }: {
        listing: PluginListing;
        snapshot: PluginsSnapshot;
        bridge: PluginsBridge;
        offer: PluginOffer;
        href: string;
        name: string;
        locale: string;
        go: (href: string) => void;
        onInstall: (entry: PluginEntry) => void;
        onUninstall: (id: string, name: string) => void;
        onFailed: (key: string) => void;
    }
): OverflowEntry[] {
    const entries: OverflowEntry[] = [{ key: "details", label: say(t, "card.details"), onSelect: () => go(href) }];
    const installed = listing.installed;
    if (!installed) return entries;
    const busy = offer.kind === "installing";
    const hint = busy ? say(t, "menu.busy") : undefined;
    if (installed.manifest) entries.push({ key: "settings", label: say(t, "detail.settings"), onSelect: () => go(`${href}#settings`) });
    const entry = listing.entry;
    if (offer.kind === "update" && entry) entries.push({ key: "update", label: say(t, "card.update", { version: offer.version }), onSelect: () => onInstall(entry) });
    const runAction = bridge.runAction;
    if (runAction) {
        for (const action of installed.actions) {
            entries.push({
                key: `action:${action.id}`,
                label: pluginText(action.label, locale),
                disabled: busy,
                hint,
                onSelect: () => void runAction(listing.id, action.id).catch(() => false)
            });
        }
    }
    const setAutoUpdate = bridge.setAutoUpdate;
    if (snapshot.autoUpdate !== null && setAutoUpdate) {
        const on = installed.autoUpdate ?? snapshot.autoUpdate;
        entries.push({
            key: "auto",
            label: on ? say(t, "menu.autoOff") : say(t, "menu.autoOn"),
            onSelect: () =>
                void setAutoUpdate(listing.id, !on)
                    .then((done) => {
                        if (!done) throw new Error("refused");
                    })
                    .catch(() => onFailed("auto.failed"))
        });
    }
    entries.push({
        key: "enabled",
        label: installed.enabled ? say(t, "menu.turnOff") : say(t, "menu.turnOn"),
        disabled: busy,
        hint,
        onSelect: () =>
            void bridge
                .setEnabled(listing.id, !installed.enabled)
                .then((done) => {
                    if (!done) throw new Error("refused");
                })
                .catch(() => onFailed("detail.toggleFailed"))
    });
    entries.push({ key: "uninstall", label: say(t, "detail.uninstall"), danger: true, disabled: busy, hint, onSelect: () => onUninstall(listing.id, name) });
    return entries;
}

type Check = { readonly kind: "idle" | "checking" | "failed" } | { readonly kind: "done"; readonly count: number };

/**
 * Look at the plugin list now instead of waiting for the next scheduled look
 * (the app keeps one for hours): "Checking..." while it looks, then what it
 * found. A newer version shows on its card as soon as the list arrives.
 */
function CheckForUpdates({ bridge }: { bridge: PluginsBridge }) {
    const t = useTranslations("account");
    const [check, setCheck] = useState<Check>({ kind: "idle" });
    const run = () => {
        if (check.kind === "checking") return;
        setCheck({ kind: "checking" });
        void (async () => {
            const outcome = await bridge.refresh().catch(() => "failed" as const);
            const read = outcome === "failed" ? null : readPluginsSnapshot(await bridge.get().catch(() => null));
            setCheck(read ? { kind: "done", count: read.installed.filter((item) => item.update).length } : { kind: "failed" });
        })();
    };
    const checking = check.kind === "checking";
    const result =
        check.kind === "failed" ? say(t, "check.failed") : check.kind === "done" ? (check.count > 0 ? say(t, "check.found", { count: check.count }) : say(t, "check.none")) : "";
    return (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className={cn(settingType.body, "min-w-0 text-muted-foreground")} role="status" aria-live="polite">
                {result}
            </span>
            <Button size="sm" variant="secondary" onClick={run} disabled={checking} aria-busy={checking}>
                {checking ? <Loader2 className="size-4 animate-spin" /> : null}
                {checking ? say(t, "check.running") : say(t, "check.action")}
            </Button>
        </div>
    );
}

function PluginCard({
    listing,
    snapshot,
    bridge,
    onInstall,
    kind
}: {
    listing: PluginListing;
    snapshot: PluginsSnapshot;
    bridge: PluginsBridge;
    onInstall: (entry: PluginEntry) => void;
    kind?: string;
}) {
    const t = useTranslations("account");
    const router = useRouter();
    const toast = useToast();
    const locale = useLocale();
    const [uninstall, uninstallDialog] = useUninstall(bridge);
    const manifest = manifestOf(listing);
    if (!manifest) return null;
    const offer = pluginOffer(snapshot, listing.id, listing.entry);
    const run = listing.installed ? runLabel(t, listing.installed, listing.entry, locale) : null;
    const href = hrefOf(listing.id);
    const tint = tintFor(listing.id);
    const entries = pluginMenu(t, {
        listing,
        snapshot,
        bridge,
        offer,
        href,
        name: manifest.name,
        locale,
        go: (to) => router.push(to),
        onInstall,
        onUninstall: uninstall,
        onFailed: (key) => toast.show({ title: say(t, key) })
    });
    return (
        <>
            <StoreCard
                preview={
                    <Link href={href} tabIndex={-1} aria-hidden className="block border-b border-border">
                        <StorePreview
                            name={manifest.name}
                            summary={manifest.summary}
                            mark={<PluginIcon entry={listing.entry} size={44} />}
                            tint={tint}
                            ink={initialsInk(tint)}
                            shot={null}
                            photo={listing.entry?.picture ?? null}
                            alt={say(t, "card.picture", { name: manifest.name })}
                        />
                    </Link>
                }
                mark={<PluginIcon entry={listing.entry} size={40} />}
                title={
                    <Link href={href} className="block truncate font-medium hover:underline" title={manifest.name}>
                        {manifest.name}
                    </Link>
                }
                byline={say(t, "card.by", { publisher: manifest.publisher })}
                summary={manifest.summary}
                badges={
                    <>
                        {kind ? <Badge className="border-primary/40 text-primary">{kind}</Badge> : null}
                        <Badge>{say(t, `category.${manifest.category}`)}</Badge>
                    </>
                }
                status={run ? <StatusBadge status={run.status} label={run.label} /> : null}
                actions={
                    <>
                        <OfferButton offer={offer} href={href} onInstall={() => listing.entry && onInstall(listing.entry)} />
                        <OverflowMenu label={say(t, "card.more", { name: manifest.name })} entries={entries} />
                    </>
                }
            />
            {uninstallDialog}
        </>
    );
}

export function PluginsStore() {
    const t = useTranslations("account");
    const state = usePlugins();
    const [tab, setTab] = useState<Tab>("browse");
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<Category>("");
    const snapshot = state.kind === "ready" ? state.snapshot : null;
    const [startInstall, installDialog] = useInstallFlow(state.kind === "ready" || state.kind === "loading" ? state.bridge : null, snapshot);
    const listings = useMemo(() => (snapshot ? pluginListings(snapshot) : []), [snapshot]);
    const needle = query.trim().toLowerCase();
    const shown = listings.filter((listing) => {
        const manifest = manifestOf(listing);
        if (!manifest) return false;
        if (tab === "installed" && !listing.installed) return false;
        if (tab === "updates" && !listing.installed?.update) return false;
        if (category && manifest.category !== category) return false;
        return !needle || `${manifest.name} ${manifest.publisher} ${manifest.summary}`.toLowerCase().includes(needle);
    });
    const updates = listings.filter((listing) => listing.installed?.update).length;

    let body: ReactNode;
    if (state.kind === "browser" || state.kind === "old-app") body = <NotHere state={state} />;
    else if (!snapshot || state.kind !== "ready") {
        body = (
            <StoreSection label={say(t, `tabs.${tab}`)}>
                <StoreCardSkeletons />
            </StoreSection>
        );
    } else if (shown.length > 0) {
        body = (
            <StoreSection label={say(t, `tabs.${tab}`)}>
                {shown.map((listing) => (
                    <PluginCard key={listing.id} listing={listing} snapshot={snapshot} bridge={state.bridge} onInstall={startInstall} />
                ))}
            </StoreSection>
        );
    } else if (needle || category) body = <StoreNoMatch>{say(t, "empty.noMatch", { query: query.trim() })}</StoreNoMatch>;
    else if (tab === "installed") body = <StoreNoMatch>{say(t, "empty.installed")}</StoreNoMatch>;
    else if (tab === "updates") body = <StoreNoMatch>{say(t, "empty.updates")}</StoreNoMatch>;
    else body = <StoreNoMatch>{snapshot.catalog ? say(t, "empty.catalog") : say(t, "empty.offline")}</StoreNoMatch>;

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                <SegmentedControl
                    value={tab}
                    onValueChange={(value: string) => setTab(value as Tab)}
                    aria-label={say(t, "page.title")}
                    options={[
                        { value: "browse", label: say(t, "tabs.browse") },
                        { value: "installed", label: say(t, "tabs.installed") },
                        { value: "updates", label: updates > 0 ? `${say(t, "tabs.updates")} (${updates})` : say(t, "tabs.updates") }
                    ]}
                />
                {state.kind === "ready" || state.kind === "loading" ? <CheckForUpdates bridge={state.bridge} /> : null}
            </div>
            <StoreFilters
                query={query}
                onQueryChange={setQuery}
                category={category}
                onCategoryChange={setCategory}
                categories={[{ value: "" as Category, label: say(t, "category.all") }, ...PLUGIN_CATEGORIES.map((value) => ({ value, label: say(t, `category.${value}`) }))]}
                words={{ search: say(t, "filters.search"), categories: say(t, "filters.categories") }}
            />
            {snapshot && snapshot.installed.length > 0 && state.kind === "ready" ? <AutoUpdateRow bridge={state.bridge} snapshot={snapshot} id={null} /> : null}
            {body}
            {installDialog}
        </div>
    );
}

/**
 * The plugins as the Marketplace lists them, on a shelf of their own after the
 * apps: the same cards and install flow as the store above, each marked as an
 * plugin. Outside the desktop app there is nothing to install them with, so the
 * shelf says so and offers the app. A search or category that leaves none hides it.
 */
export function PluginsShelf({ query, category, byName, label, kind }: { query: string; category: string; byName: boolean; label: string; kind: string }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const state = usePlugins();
    const snapshot = state.kind === "ready" ? state.snapshot : null;
    const [startInstall, installDialog] = useInstallFlow(state.kind === "ready" || state.kind === "loading" ? state.bridge : null, snapshot);
    const needle = query.trim().toLocaleLowerCase(locale);
    const shown = useMemo(() => {
        const listed = (snapshot ? pluginListings(snapshot) : []).filter((listing) => {
            const manifest = manifestOf(listing);
            if (!manifest || (category && manifest.category !== category)) return false;
            return !needle || `${manifest.name} ${manifest.publisher} ${manifest.summary}`.toLocaleLowerCase(locale).includes(needle);
        });
        return byName ? listed.sort((a, b) => (manifestOf(a)?.name ?? "").localeCompare(manifestOf(b)?.name ?? "", locale)) : listed;
    }, [snapshot, category, needle, byName, locale]);

    let body: ReactNode;
    if (state.kind === "browser" || state.kind === "old-app") {
        if (needle || category) return null;
        body = (
            <div className="col-span-full min-w-0">
                <NotHere state={state} />
            </div>
        );
    } else if (!snapshot || state.kind !== "ready") {
        body = <StoreCardSkeletons />;
    } else if (shown.length === 0) {
        if (needle || category || snapshot.catalog) return null;
        body = (
            <div className="col-span-full min-w-0">
                <Notice>{say(t, "empty.offline")}</Notice>
            </div>
        );
    } else body = shown.map((listing) => <PluginCard key={listing.id} listing={listing} snapshot={snapshot} bridge={state.bridge} onInstall={startInstall} kind={kind} />);

    return (
        <>
            <StoreSection label={label}>{body}</StoreSection>
            {installDialog}
        </>
    );
}

/**
 * Whether updates go in by themselves: for every plugin (`id` null) or one.
 * Drawn only by an app that keeps the setting; an older one puts none in.
 */
function AutoUpdateRow({ bridge, snapshot, id }: { bridge: PluginsBridge; snapshot: PluginsSnapshot; id: string | null }) {
    const t = useTranslations("account");
    const toast = useToast();
    const own = id === null ? null : (snapshot.installed.find((item) => item.id === id)?.autoUpdate ?? null);
    const held = own ?? snapshot.autoUpdate;
    const [shown, setShown] = useState<boolean | null>(null);
    useEffect(() => setShown(null), [held]);
    const setAutoUpdate = bridge.setAutoUpdate;
    if (snapshot.autoUpdate === null || !setAutoUpdate) return null;
    const checked = shown ?? held ?? true;
    const change = (value: boolean) => {
        if (value === checked) return;
        setShown(value);
        void setAutoUpdate(id, value)
            .then((done) => {
                if (!done) throw new Error("refused");
            })
            .catch(() => {
                setShown(null);
                toast.show({ title: say(t, "auto.failed") });
            });
    };
    const label = id === null ? say(t, "auto.all") : say(t, "auto.one");
    return (
        <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
                <p className={cn(settingType.body, "truncate font-medium")}>{label}</p>
                <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "auto.hint")}</p>
            </div>
            <Switch checked={checked} onChange={change} aria-label={label} />
        </div>
    );
}

type SettingProps = { setting: PluginSetting; value: PluginSettingValue; locale: string; onChange: (value: PluginSettingValue) => void };

/** One declared setting's control: Polaris's own for its kind, never a plugin's markup. */
function SettingControl({ setting, value, locale, onChange, width }: SettingProps & { width: string }) {
    const t = useTranslations("account");
    const extraActions = useDeviceActionOptions();
    const label = pluginText(setting.label, locale);
    let control: ReactNode;
    switch (setting.kind) {
        case "toggle":
            control = <Switch checked={value === true} onChange={onChange} aria-label={label} />;
            break;
        case "choice":
            control = (
                <Select
                    value={typeof value === "string" ? value : setting.default}
                    onValueChange={onChange}
                    aria-label={label}
                    className={width}
                    options={setting.options.map((option) => ({ value: option.value, label: pluginText(option.label, locale) }))}
                />
            );
            break;
        case "range":
            control = (
                <ControlSlider
                    className={width}
                    value={typeof value === "number" ? value : setting.default}
                    min={setting.min}
                    max={setting.max}
                    step={setting.step}
                    label={label}
                    onCommit={onChange}
                />
            );
            break;
        case "action":
            control = (
                <Select
                    value={typeof value === "string" ? (value === "call.leave" ? "call.hangup" : value) : "none"}
                    onValueChange={(next) => onChange(next === "none" ? null : next)}
                    aria-label={label}
                    className={width}
                    options={[
                        { value: "none", label: say(t, "action.none") },
                        ...PICKABLE_ACTIONS.map((action) => ({ value: action, label: say(t, `action.${action.slice("call.".length)}`) })),
                        ...extraActions,
                        // A custom action deleted since, or one this page has not heard of yet: shown, not silently swapped.
                        ...(typeof value === "string" && value !== "call.leave" && !(PICKABLE_ACTIONS as readonly string[]).includes(value) && !extraActions.some((option) => option.value === value) ? [{ value, label: say(t, "action.missing") }] : [])
                    ]}
                />
            );
            break;
    }
    return control;
}

/** One declared setting as a row: its name and hint, then its control. */
function SettingRow(props: SettingProps) {
    const label = pluginText(props.setting.label, props.locale);
    const hint = props.setting.hint ? pluginText(props.setting.hint, props.locale) : null;
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 flex-1 basis-48">
                <p className={cn(settingType.body, "truncate font-medium")} title={label}>
                    {label}
                </p>
                {hint ? <p className={settingType.hint}>{hint}</p> : null}
            </div>
            <SettingControl {...props} width="w-full sm:w-48" />
        </div>
    );
}

/** The device's own part above a tile: a knob with its pointer, or a button lit while it does something. */
function TileShape({ look, lit }: { look: "dials" | "buttons"; lit: boolean }) {
    if (look === "dials") {
        return (
            <span aria-hidden className="relative block size-11 shrink-0 rounded-full border-2 border-border bg-muted">
                <span className="absolute left-1/2 top-1 h-3 w-0.5 -translate-x-1/2 rounded-full bg-primary" />
            </span>
        );
    }
    return <span aria-hidden className={`block h-8 w-11 shrink-0 rounded-md border-2 ${lit ? "border-primary bg-primary/30" : "border-border bg-muted"}`} />;
}

/** One setting as a tile of the device (a knob, a button): its shape, its name, its control. */
function SettingTile({ look, ...props }: SettingProps & { look: "dials" | "buttons" }) {
    const label = pluginText(props.setting.label, props.locale);
    const lit = props.value !== null && props.value !== false && props.value !== "none";
    return (
        <div id={pluginSettingAnchor(props.setting.key)} className="flex min-w-0 scroll-mt-24 flex-col items-center gap-2 rounded-md border border-border p-3">
            <TileShape look={look} lit={lit} />
            <p className={cn(settingType.hint, "max-w-full truncate")} title={label}>
                {label}
            </p>
            <SettingControl {...props} width="w-full" />
        </div>
    );
}

/** A titled group of settings, as rows or as the device's tiles. */
function SettingGroup({ group, locale, children }: { group: PluginSettingGroup | null; locale: string; children: ReactNode }) {
    if (!group) return <div className="flex min-w-0 flex-col divide-y divide-border">{children}</div>;
    const hint = group.hint ? pluginText(group.hint, locale) : null;
    const tiles = group.look === "dials" || group.look === "buttons";
    return (
        <section id={pluginGroupAnchor(group.key)} className="flex min-w-0 scroll-mt-24 flex-col gap-2" aria-label={pluginText(group.label, locale)}>
            <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">{pluginText(group.label, locale)}</h3>
                {hint ? <p className={settingType.hint}>{hint}</p> : null}
            </div>
            <div className={tiles ? "grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4" : "flex min-w-0 flex-col divide-y divide-border"}>{children}</div>
        </section>
    );
}

/** The settings, changed at once on the page and put back when the app refuses. */
function PluginSettings({ bridge, manifest }: { bridge: PluginsBridge; manifest: PluginManifest }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const toast = useToast();
    // What was kept from the last visit draws at once; the app's answer replaces it only when it differs.
    const values = usePluginSettings(bridge, manifest);
    const setValues = (next: Record<string, PluginSettingValue>) => changePluginSettings(manifest.id, manifest.version, next);

    // A search result names one setting or group (`#setting-<key>`, `#group-<key>`); they are drawn only once the values arrive.
    const loaded = values !== null;
    useEffect(() => {
        if (!loaded) return;
        const id = decodeURIComponent(window.location.hash.slice(1));
        if (id) document.getElementById(id)?.scrollIntoView({ block: "center" });
    }, [loaded]);

    if (manifest.settings.length === 0) return <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "detail.noSettings")}</p>;
    if (!values) return <Skeleton className="h-24 w-full" />;

    const change = (key: string, value: PluginSettingValue) => {
        if (values[key] === value) return;
        const before = values;
        setValues({ ...values, [key]: value });
        void bridge
            .setSetting(manifest.id, key, value)
            .then((after) => {
                if (!after) throw new Error("refused");
                keepPluginSettings(manifest.id, manifest.version, readPluginSettingValues(manifest.settings, after));
            })
            .catch(() => {
                setValues(before);
                toast.show({ title: say(t, "detail.saveFailed") });
            });
    };

    return (
        <div className="flex min-w-0 flex-col gap-5">
            {pluginSettingSections(manifest).map(({ group, settings }) => (
                <SettingGroup key={group?.key ?? ""} group={group} locale={locale}>
                    {settings.map((setting) => {
                        const props: SettingProps = { setting, value: values[setting.key] ?? null, locale, onChange: (value) => change(setting.key, value) };
                        return group && (group.look === "dials" || group.look === "buttons") ? <SettingTile key={setting.key} look={group.look} {...props} /> : (
                            <div key={setting.key} id={pluginSettingAnchor(setting.key)} className="min-w-0 scroll-mt-24">
                                <SettingRow {...props} />
                            </div>
                        );
                    })}
                </SettingGroup>
            ))}
        </div>
    );
}

/** Each view's last reported height, for the tab's lifetime. */
const viewHeights = new Map<string, number>();

/**
 * The plugin's own view, for what its declared settings cannot draw (a preview,
 * never a control: those are declared settings, drawn below it). A frame
 * with scripts and nothing else (no same origin, so it reaches neither this
 * page nor its storage), served by the app from the installed package. It gets
 * the page's tokens, theme and locale when it is ready and again whenever one
 * of them changes while it is open, and every call it makes is read here and
 * judged by the app. It has no edge and no scrollbar of its own: its height is
 * the one it reports, so it reads as part of this page.
 */
export function PluginView({ bridge, manifest, view }: { bridge: PluginsBridge; manifest: PluginManifest; view: string }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const frame = useRef<HTMLIFrameElement>(null);
    // The height it last reported, so it opens at its size instead of growing into it.
    const [height, setHeight] = useState<number>(() => viewHeights.get(manifest.id) ?? PLUGIN_VIEW_HEIGHT.min * 2);
    const viewCall = bridge.viewCall;
    // The hello is built from the latest locale, and sent again only when it differs
    // from the last one the view got, so an unrelated class on the root reaches nobody.
    const localeNow = useRef(locale);
    const ready = useRef(false);
    const lastHello = useRef("");
    const sendHello = useCallback((force: boolean) => {
        const target = frame.current?.contentWindow;
        if (!target || !ready.current) return;
        const hello = pluginViewHello(localeNow.current, pageIsDark(), getComputedStyle(document.documentElement));
        const said = JSON.stringify(hello);
        if (!force && said === lastHello.current) return;
        lastHello.current = said;
        target.postMessage(hello, "*");
    }, []);

    useEffect(() => watchPluginViewLook(() => sendHello(false)), [sendHello]);
    useEffect(() => {
        localeNow.current = locale;
        sendHello(false);
    }, [locale, sendHello]);

    // Settings changed elsewhere (the list below, another window) reach an open view: it shares
    // the one kept copy the list draws from (`usePluginSettings`), so no read of its own.
    const values = usePluginSettings(bridge, manifest);
    const valuesNow = useRef(values);
    valuesNow.current = values;
    const lastSettings = useRef("");
    const sendSettings = useCallback(() => {
        const target = frame.current?.contentWindow;
        const current = valuesNow.current;
        if (!current || !target || !ready.current) return;
        const said = JSON.stringify(current);
        if (said === lastSettings.current) return;
        lastSettings.current = said;
        target.postMessage({ type: "settings", values: current }, "*");
    }, []);
    useEffect(() => sendSettings(), [values, sendSettings]);

    useEffect(() => {
        if (!viewCall) return;
        const target = () => frame.current?.contentWindow ?? null;
        const post = (message: unknown) => target()?.postMessage(message, "*");
        const heard = (event: MessageEvent) => {
            // Only its own frame; a sandboxed frame's origin is "null".
            if (!target() || event.source !== target()) return;
            const message = readPluginViewMessage(event.data);
            if (!message) return;
            if (message.type === "ready") {
                // A view that reloads says ready again, and gets the whole hello again.
                ready.current = true;
                lastSettings.current = "";
                sendHello(true);
                sendSettings();
                return;
            }
            if (message.type === "resize") {
                const next = pluginViewHeight(message.height);
                viewHeights.set(manifest.id, next);
                setHeight(next);
                return;
            }
            void viewCall(manifest.id, message.method, message.params)
                .then(readPluginViewReply, () => readPluginViewReply(null))
                .then((reply) => post({ type: "reply", id: message.id, ...reply }));
        };
        window.addEventListener("message", heard);
        return () => window.removeEventListener("message", heard);
    }, [viewCall, manifest.id, sendHello, sendSettings]);

    if (!viewCall) return null;
    return (
        <iframe
            ref={frame}
            src={pluginViewUrl(manifest.id, view)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={say(t, "detail.view", { name: manifest.name })}
            scrolling="no"
            className="block w-full min-w-0 border-0 bg-transparent"
            style={{ height }}
        />
    );
}

/** Runs what the app offers to do for a plugin; one at a time, the snapshot that follows says how it went. */
function useHostAction(bridge: PluginsBridge | null): { running: string | null; run: (id: string, action: string, failed?: () => void) => void } {
    const [running, setRunning] = useState<string | null>(null);
    const run = (id: string, action: string, failed?: () => void) => {
        setRunning(action);
        void (bridge?.runAction?.(id, action) ?? Promise.resolve(false))
            .catch(() => false)
            .then((done) => {
                if (done !== true) failed?.();
            })
            .finally(() => setRunning(null));
    };
    return { running, run };
}

/**
 * The host action that closes the device's own vendor program and gives the
 * device to Polaris (desktop `plugins/collision.ts`). The page words it itself
 * and asks first; any other action is drawn in the words it comes with.
 */
const TAKE_OVER_ACTION = "useInPolaris";

/** What the host action reads as: the page's own words for one it knows, the action's otherwise. */
function hostActionWords(t: Words, action: PluginHostAction, locale: string): { label: string; detail: string | null } {
    if (action.id === TAKE_OVER_ACTION) {
        const app = action.subject ?? say(t, "official.appName");
        return { label: say(t, "hostAction.useInPolaris.label"), detail: say(t, "hostAction.useInPolaris.detail", { app }) };
    }
    return { label: pluginText(action.label, locale), detail: action.detail ? pluginText(action.detail, locale) : null };
}

/** A catalog screenshot as the store's gallery takes one: the same picture in both themes and on a phone. */
function galleryShot(url: string): AppScreenshot {
    const one = { desktop: url, mobile: url };
    return { dark: one, light: one };
}

/**
 * One plugin's page, laid out as a Polaris app's is (`components/store-detail`):
 * the way back, the header with its status, the row of what can be done with
 * it - install or update, its settings, what the app offers to do for it,
 * turning it off and uninstalling it - then its screenshots, its settings,
 * What's new one version at a time, the permissions it asks for, and the
 * Information list.
 */
export function PluginPage({ id }: { id: string; }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const state = usePlugins();
    const toast = useToast();
    const bridge = state.kind === "ready" || state.kind === "loading" ? state.bridge : null;
    const [startUninstall, confirmElement] = useUninstall(bridge);
    const [startInstall, installDialog] = useInstallFlow(bridge, state.kind === "ready" ? state.snapshot : null);
    const hostAction = useHostAction(bridge);
    const [confirmAction, confirmActionElement] = useConfirm();

    const back = <DetailBack href="/account/plugins">{say(t, "page.back")}</DetailBack>;
    if (state.kind === "browser" || state.kind === "old-app") {
        return (
            <div className="flex min-w-0 flex-col gap-6">
                {back}
                <NotHere state={state} />
            </div>
        );
    }
    if (state.kind === "loading") {
        return (
            <div className="flex min-w-0 flex-col gap-6">
                {back}
                <div className="flex min-w-0 gap-4" aria-hidden>
                    <Skeleton className="size-[72px] shrink-0 rounded-md" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <Skeleton className="h-7 w-48" />
                        <Skeleton className="h-4 w-32" />
                    </div>
                </div>
                <div className="flex gap-2" aria-hidden>
                    <Skeleton className="h-9 w-28" />
                    <Skeleton className="h-9 w-24" />
                </div>
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }
    const listing = pluginListings(state.snapshot).find((item) => item.id === id) ?? null;
    const manifest = listing ? manifestOf(listing) : null;
    if (!listing || !manifest) {
        return (
            <div className="flex min-w-0 flex-col gap-6">
                {back}
                <Notice>{say(t, "detail.notFound")}</Notice>
            </div>
        );
    }
    const { entry, installed } = listing;
    const offer = pluginOffer(state.snapshot, id, entry);
    const run = installed ? runLabel(t, installed, entry, locale) : null;
    const size = entry && state.snapshot.platform ? entry.packages[state.snapshot.platform]?.size : undefined;
    const requirements = pluginRequirements(manifest, state.snapshot.platform);
    const releases = entry ? pluginReleases(entry) : [];
    const actions = installed && state.bridge.runAction ? installed.actions : [];
    const busy = offer.kind === "installing";
    const runHostAction = (action: PluginHostAction) => {
        if (action.id !== TAKE_OVER_ACTION) return hostAction.run(id, action.id);
        const app = action.subject ?? say(t, "official.appName");
        void (async () => {
            const ok = await confirmAction({
                title: say(t, "hostAction.useInPolaris.title", { app }),
                description: say(t, "hostAction.useInPolaris.body", { app, device: manifest.name }),
                confirmLabel: say(t, "hostAction.useInPolaris.confirm")
            });
            if (ok) hostAction.run(id, action.id, () => toast.show({ title: say(t, "hostAction.useInPolaris.failed", { app }) }));
        })();
    };

    const toggle = (enabled: boolean) => {
        void state.bridge
            .setEnabled(id, enabled)
            .then((done) => {
                if (!done) throw new Error("refused");
            })
            .catch(() => toast.show({ title: say(t, "detail.toggleFailed") }));
    };

    return (
        <div className="flex min-w-0 flex-col gap-6">
            {back}

            <DetailHeader mark={<PluginIcon entry={entry} size={72} />} name={manifest.name} byline={say(t, "card.by", { publisher: manifest.publisher })}>
                <p className={cn(settingType.body, "break-words")}>{manifest.summary}</p>
                {run ? (
                    <div className="mt-1">
                        <StatusBadge status={run.status} label={run.label} />
                    </div>
                ) : null}
                {run?.detail ? <p className={cn(settingType.body, "text-muted-foreground break-words")}>{run.detail}</p> : null}
            </DetailHeader>

            <section className="flex min-w-0 flex-col gap-3" aria-label={say(t, "detail.actions")}>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {offer.kind !== "installed" ? <OfferButton offer={offer} href={hrefOf(id)} size="md" onInstall={() => entry && startInstall(entry)} /> : null}
                    {installed?.manifest ? (
                        <Button asChild variant="secondary">
                            <a href="#settings">{say(t, "detail.settings")}</a>
                        </Button>
                    ) : null}
                    {actions.map((action) => (
                        <Button key={action.id} variant="secondary" disabled={hostAction.running !== null || busy} onClick={() => runHostAction(action)}>
                            {hostAction.running === action.id ? <Loader2 aria-hidden className="size-4 shrink-0 animate-spin" /> : null}
                            {hostActionWords(t, action, locale).label}
                        </Button>
                    ))}
                    {installed ? (
                        <Button variant="ghost" className="hover:text-danger" disabled={busy} onClick={() => startUninstall(id, manifest.name)}>
                            <Trash2 className="size-4" />
                            {say(t, "detail.uninstall")}
                        </Button>
                    ) : null}
                </div>
                {actions.map((action) => {
                    const detail = hostActionWords(t, action, locale).detail;
                    return detail ? (
                        <p key={action.id} className={cn(settingType.body, "text-muted-foreground break-words")}>
                            {detail}
                        </p>
                    ) : null;
                })}
                {installed ? (
                    <label className="flex min-w-0 items-center justify-between gap-3 sm:justify-start">
                        <span className={cn(settingType.body, "min-w-0")}>{say(t, "detail.enabled")}</span>
                        <Switch checked={installed.enabled} onChange={toggle} disabled={busy} aria-label={say(t, "detail.enabled")} />
                    </label>
                ) : null}
                <OfficialSoftware id={id} bridge={state.bridge} />
                {installed?.update && installed.consent.length > 0 ? (
                    <Notice
                        action={
                            entry ? (
                                <Button size="sm" onClick={() => startInstall(entry)}>
                                    {say(t, "notice.review")}
                                </Button>
                            ) : undefined
                        }
                    >
                        {say(t, "notice.consent", { version: installed.update })}
                    </Notice>
                ) : null}
                {installed?.failed ? <Notice>{say(t, "notice.failed", { version: installed.failed })}</Notice> : null}
            </section>

            {entry && entry.screenshots.length > 0 ? <ScreenshotGallery name={manifest.name} shots={entry.screenshots.map(galleryShot)} /> : null}

            {installed && installed.manifest ? (
                <DetailSection id="settings" title={say(t, "detail.settings")}>
                    <AutoUpdateRow bridge={state.bridge} snapshot={state.snapshot} id={id} />
                    {installed.manifest.view ? <PluginView bridge={state.bridge} manifest={installed.manifest} view={installed.manifest.view} /> : null}
                    {installed.profiles && state.bridge.profile ? <PluginProfiles bridge={state.bridge} id={id} profiles={installed.profiles} /> : null}
                    {state.bridge.actions && installed.manifest?.settings.some((setting) => setting.kind === "action") ? <PluginActions bridge={state.bridge} /> : null}
                    <PluginSettings bridge={state.bridge} manifest={installed.manifest} />
                </DetailSection>
            ) : null}

            {releases.length > 0 ? (
                <DetailSection title={installed?.update ? say(t, "detail.changelogFor", { version: installed.update }) : say(t, "detail.changelog")}>
                    <DetailReleases
                        releases={releases}
                        current={installed?.version ?? null}
                        words={{
                            version: (version) => say(t, "detail.release", { version }),
                            earlier: say(t, "detail.releaseEarlier"),
                            current: say(t, "detail.releaseCurrent"),
                            showAll: (count) => say(t, "detail.releasesAll", { count }),
                            showLess: say(t, "detail.releasesFewer")
                        }}
                    />
                </DetailSection>
            ) : null}

            <DetailSection title={say(t, "detail.permissions")}>
                {manifest.permissions.length === 0 && requirements.length === 0 ? (
                    <p className={cn(settingType.body, "text-muted-foreground")}>{say(t, "install.none")}</p>
                ) : (
                    <ul className={cn(settingType.body, "text-muted-foreground flex list-disc flex-col gap-1 ps-5")}>
                        {manifest.permissions.map((permission) => (
                            <li key={permission} className="break-words">
                                {say(t, `permission.${PERMISSION_KEY[permission]}`)}
                            </li>
                        ))}
                        {requirements.map((requirement) => (
                            <li key={`requires.${requirement.key}`} className="break-words">
                                {pluginText(requirement.label, locale)}
                            </li>
                        ))}
                    </ul>
                )}
            </DetailSection>

            <DetailSection title={say(t, "detail.information")}>
                <DetailFacts>
                    <Fact label={say(t, "detail.version")}>{installed?.version ?? manifest.version}</Fact>
                    <Fact label={say(t, "detail.size")}>{size ? formatBytes(size) : "-"}</Fact>
                    <Fact label={say(t, "detail.published")}>{entry ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(entry.published)) : "-"}</Fact>
                    <Fact label={say(t, "detail.publisher")}>{manifest.publisher}</Fact>
                    <Fact label={say(t, "detail.category")}>{say(t, `category.${manifest.category}`)}</Fact>
                </DetailFacts>
            </DetailSection>
            {confirmElement}
            {confirmActionElement}
            {installDialog}
        </div>
    );
}
