"use client";

/**
 * Device add-ons: the store (Browse / Installed / Updates, search and
 * categories) and each add-on's own page, drawn from what the desktop app
 * answers (`lib/device-addons-client`). Built from the marketplace's own store
 * pieces (`@polaris/ui/store-card`, `store-layout`), so it reads as the same
 * store. An add-on's settings are its manifest's declarative list, drawn with
 * Polaris's own controls - no add-on markup reaches this page.
 */

import Link from "next/link";
import { formatBytes } from "@polaris/core";
import { Loader2, Package } from "lucide-react";
import { useConfirm } from "@/components/confirm-dialog";
import { StoreCard, StatusBadge } from "@polaris/ui/store-card";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { OverflowMenu, StoreFilters, StoreNoMatch, StoreSection } from "@polaris/ui/store-layout";
import { Badge, Button, ControlSlider, SegmentedControl, Select, Skeleton, Switch, useToast } from "@polaris/ui";
import {
    ADDON_ACTIONS,
    ADDON_CATEGORIES,
    addonText,
    addonSettingSections,
    readAddonSettingValues,
    type AddonEntry,
    type AddonManifest,
    type AddonSetting,
    type AddonSettingGroup,
    type AddonSettingValue,
    type AddonsSnapshot,
    type InstalledAddon
} from "@polaris/core/device-addons";
import {
    addonListings,
    addonOffer,
    useAddons,
    useInstallAddon,
    statusSentence,
    PERMISSION_KEY,
    type AddonListing,
    type AddonOffer,
    type AddonsBridge,
    type AddonsState
} from "@/lib/device-addons-client";
import { pageIsDark } from "@/lib/page-theme";
import { OfficialSoftware } from "./official-software";
import { useOfficialChoice } from "./official-choice-dialog";
import { addonViewHeight, addonViewHello, addonViewUrl, readAddonViewMessage, readAddonViewReply, watchAddonViewLook, ADDON_VIEW_HEIGHT } from "@/lib/device-addon-view";

type Words = ReturnType<typeof useTranslations<"account">>;
type Tab = "browse" | "installed" | "updates";
type Category = "" | (typeof ADDON_CATEGORIES)[number];

/** The picker's list: `call.leave` reads as hang up, so it is offered once, as `call.hangup`. */
const PICKABLE_ACTIONS = ADDON_ACTIONS.filter((action) => action !== "call.leave");

function say(t: Words, key: string, values?: Record<string, string | number>): string {
    return (t as unknown as (key: string, values?: Record<string, string | number>) => string)(`addons.${key}`, values);
}

function manifestOf(listing: AddonListing): AddonManifest | null {
    return listing.entry ?? listing.installed?.manifest ?? null;
}

/** The badge's short word for how an add-on runs, and the sentence its add-on said about the device, if any. */
function runLabel(t: Words, installed: InstalledAddon): { status: string; label: string; detail?: string } {
    const run = installed.run;
    if ("status" in run && run.status && (run.state === "running" || run.state === "starting")) {
        const sentence = statusSentence(run.status.code);
        return { status: run.status.state === "connected" ? "running" : run.status.state === "error" ? "failed" : "idle", label: say(t, `status.${run.status.state}`), detail: sentence ? say(t, sentence) : run.status.detail };
    }
    return { status: run.state === "running" ? "running" : run.state === "failed" || run.state === "missing" ? "failed" : "idle", label: say(t, `status.${run.state}`) };
}

function AddonIcon({ entry, size }: { entry: AddonEntry | null; size: number }) {
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

/** The leading action for one add-on: install, its progress, update, configure, or why it cannot. */
function OfferButton({ offer, href, onInstall, size = "sm" }: { offer: AddonOffer; href: string; onInstall: () => void; size?: "sm" | "md" }) {
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
                    {offer.percent === null ? say(t, "card.preparing") : say(t, "card.installing", { percent: offer.percent })}
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
function useInstallFlow(bridge: AddonsBridge | null, snapshot: AddonsSnapshot | null): [(entry: AddonEntry) => void, ReactNode] {
    const t = useTranslations("account");
    const toast = useToast();
    const [confirm, element] = useConfirm();
    const install = useInstallAddon(bridge);
    const [offerOfficial, officialElement] = useOfficialChoice(bridge);
    const start = (entry: AddonEntry) => {
        const installed = snapshot?.installed.find((item) => item.id === entry.id) ?? null;
        const updating = Boolean(installed?.update);
        const listed = updating ? entry.permissions.filter((permission) => !installed?.granted.includes(permission)) : entry.permissions;
        const asks = listed.map((permission) => `- ${say(t, `permission.${PERMISSION_KEY[permission]}`)}`);
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
            const problem = await install(entry);
            if (problem) toast.show({ title: say(t, `failure.${problem === "app-version" ? "appVersion" : problem}`) });
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
    return `/account/addons/${encodeURIComponent(id)}`;
}

function Notice({ children, action }: { children: ReactNode; action?: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">
            <span className="min-w-0">{children}</span>
            {action}
        </div>
    );
}

function NotHere({ state }: { state: AddonsState }) {
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

function StoreSkeleton() {
    return (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" aria-hidden>
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
        </div>
    );
}

function AddonCard({ listing, snapshot, onInstall, kind }: { listing: AddonListing; snapshot: AddonsSnapshot; onInstall: (entry: AddonEntry) => void; kind?: string }) {
    const t = useTranslations("account");
    const manifest = manifestOf(listing);
    if (!manifest) return null;
    const offer = addonOffer(snapshot, listing.id, listing.entry);
    const run = listing.installed ? runLabel(t, listing.installed) : null;
    const href = hrefOf(listing.id);
    return (
        <StoreCard
            preview={
                <div className="grid aspect-[16/10] place-items-center bg-muted">
                    <AddonIcon entry={listing.entry} size={56} />
                </div>
            }
            mark={<AddonIcon entry={listing.entry} size={40} />}
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
                    <OverflowMenu label={say(t, "card.more", { name: manifest.name })} entries={[{ key: "details", label: say(t, "card.details"), onSelect: () => window.location.assign(href) }]} />
                </>
            }
        />
    );
}

export function AddonsStore() {
    const t = useTranslations("account");
    const state = useAddons();
    const [tab, setTab] = useState<Tab>("browse");
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<Category>("");
    const snapshot = state.kind === "ready" ? state.snapshot : null;
    const [startInstall, installDialog] = useInstallFlow(state.kind === "ready" || state.kind === "loading" ? state.bridge : null, snapshot);
    const listings = useMemo(() => (snapshot ? addonListings(snapshot) : []), [snapshot]);
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
    else if (!snapshot) body = <StoreSkeleton />;
    else if (shown.length > 0) {
        body = (
            <StoreSection label={say(t, `tabs.${tab}`)}>
                {shown.map((listing) => (
                    <AddonCard key={listing.id} listing={listing} snapshot={snapshot} onInstall={startInstall} />
                ))}
            </StoreSection>
        );
    } else if (needle || category) body = <StoreNoMatch>{say(t, "empty.noMatch", { query: query.trim() })}</StoreNoMatch>;
    else if (tab === "installed") body = <StoreNoMatch>{say(t, "empty.installed")}</StoreNoMatch>;
    else if (tab === "updates") body = <StoreNoMatch>{say(t, "empty.updates")}</StoreNoMatch>;
    else body = <StoreNoMatch>{snapshot.catalog ? say(t, "empty.catalog") : say(t, "empty.offline")}</StoreNoMatch>;

    return (
        <div className="flex min-w-0 flex-col gap-4">
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
            <StoreFilters
                query={query}
                onQueryChange={setQuery}
                category={category}
                onCategoryChange={setCategory}
                categories={[{ value: "" as Category, label: say(t, "category.all") }, ...ADDON_CATEGORIES.map((value) => ({ value, label: say(t, `category.${value}`) }))]}
                words={{ search: say(t, "filters.search"), categories: say(t, "filters.categories") }}
            />
            {snapshot && snapshot.installed.length > 0 && state.kind === "ready" ? <AutoUpdateRow bridge={state.bridge} snapshot={snapshot} id={null} /> : null}
            {body}
            {installDialog}
        </div>
    );
}

/**
 * The add-ons as the Marketplace lists them, on a shelf of their own after the
 * apps: the same cards and install flow as the store above, each marked as an
 * add-on. Outside the desktop app there is nothing to install them with, so the
 * shelf says so and offers the app. A search or category that leaves none hides it.
 */
export function AddonsShelf({ query, category, byName, label, kind }: { query: string; category: string; byName: boolean; label: string; kind: string }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const state = useAddons();
    const snapshot = state.kind === "ready" ? state.snapshot : null;
    const [startInstall, installDialog] = useInstallFlow(state.kind === "ready" || state.kind === "loading" ? state.bridge : null, snapshot);
    const needle = query.trim().toLocaleLowerCase(locale);
    const shown = useMemo(() => {
        const listed = (snapshot ? addonListings(snapshot) : []).filter((listing) => {
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
    } else if (!snapshot) {
        body = (
            <div className="col-span-full min-w-0">
                <StoreSkeleton />
            </div>
        );
    } else if (shown.length === 0) {
        if (needle || category || snapshot.catalog) return null;
        body = (
            <div className="col-span-full min-w-0">
                <Notice>{say(t, "empty.offline")}</Notice>
            </div>
        );
    } else body = shown.map((listing) => <AddonCard key={listing.id} listing={listing} snapshot={snapshot} onInstall={startInstall} kind={kind} />);

    return (
        <>
            <StoreSection label={label}>{body}</StoreSection>
            {installDialog}
        </>
    );
}

/**
 * Whether updates go in by themselves: for every add-on (`id` null) or one.
 * Drawn only by an app that keeps the setting; an older one puts none in.
 */
function AutoUpdateRow({ bridge, snapshot, id }: { bridge: AddonsBridge; snapshot: AddonsSnapshot; id: string | null }) {
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
                <p className="truncate text-sm font-medium">{label}</p>
                <p className="text-sm text-muted-foreground">{say(t, "auto.hint")}</p>
            </div>
            <Switch checked={checked} onChange={change} aria-label={label} />
        </div>
    );
}

type SettingProps = { setting: AddonSetting; value: AddonSettingValue; locale: string; onChange: (value: AddonSettingValue) => void };

/** One declared setting's control: Polaris's own for its kind, never an add-on's markup. */
function SettingControl({ setting, value, locale, onChange, width }: SettingProps & { width: string }) {
    const t = useTranslations("account");
    const label = addonText(setting.label, locale);
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
                    options={setting.options.map((option) => ({ value: option.value, label: addonText(option.label, locale) }))}
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
                    options={[{ value: "none", label: say(t, "action.none") }, ...PICKABLE_ACTIONS.map((action) => ({ value: action, label: say(t, `action.${action.slice("call.".length)}`) }))]}
                />
            );
            break;
    }
    return control;
}

/** One declared setting as a row: its name and hint, then its control. */
function SettingRow(props: SettingProps) {
    const label = addonText(props.setting.label, props.locale);
    const hint = props.setting.hint ? addonText(props.setting.hint, props.locale) : null;
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 flex-1 basis-48">
                <p className="truncate text-sm font-medium" title={label}>
                    {label}
                </p>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
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
    const label = addonText(props.setting.label, props.locale);
    const lit = props.value !== null && props.value !== false && props.value !== "none";
    return (
        <div className="flex min-w-0 flex-col items-center gap-2 rounded-md border border-border p-3">
            <TileShape look={look} lit={lit} />
            <p className="max-w-full truncate text-xs text-muted-foreground" title={label}>
                {label}
            </p>
            <SettingControl {...props} width="w-full" />
        </div>
    );
}

/** A titled group of settings, as rows or as the device's tiles. */
function SettingGroup({ group, locale, children }: { group: AddonSettingGroup | null; locale: string; children: ReactNode }) {
    if (!group) return <div className="flex min-w-0 flex-col divide-y divide-border">{children}</div>;
    const hint = group.hint ? addonText(group.hint, locale) : null;
    const tiles = group.look === "dials" || group.look === "buttons";
    return (
        <section className="flex min-w-0 flex-col gap-2" aria-label={addonText(group.label, locale)}>
            <div className="min-w-0">
                <h3 className="truncate text-sm font-medium">{addonText(group.label, locale)}</h3>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            <div className={tiles ? "grid min-w-0 grid-cols-2 gap-2 md:grid-cols-4" : "flex min-w-0 flex-col divide-y divide-border"}>{children}</div>
        </section>
    );
}

/** The settings, changed at once on the page and put back when the app refuses. */
function AddonSettings({ bridge, manifest }: { bridge: AddonsBridge; manifest: AddonManifest }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const toast = useToast();
    const [values, setValues] = useState<Record<string, AddonSettingValue> | null>(null);

    useEffect(() => {
        let live = true;
        void bridge
            .settings(manifest.id)
            .then((stored) => {
                if (live && stored) setValues(readAddonSettingValues(manifest.settings, stored));
            })
            .catch(() => undefined);
        return () => {
            live = false;
        };
    }, [bridge, manifest]);

    if (manifest.settings.length === 0) return <p className="text-sm text-muted-foreground">{say(t, "detail.noSettings")}</p>;
    if (!values) return <Skeleton className="h-24 w-full" />;

    const change = (key: string, value: AddonSettingValue) => {
        if (values[key] === value) return;
        const before = values;
        setValues({ ...values, [key]: value });
        void bridge
            .setSetting(manifest.id, key, value)
            .then((after) => {
                if (!after) throw new Error("refused");
                setValues(readAddonSettingValues(manifest.settings, after));
            })
            .catch(() => {
                setValues(before);
                toast.show({ title: say(t, "detail.saveFailed") });
            });
    };

    return (
        <div className="flex min-w-0 flex-col gap-5">
            {addonSettingSections(manifest).map(({ group, settings }) => (
                <SettingGroup key={group?.key ?? ""} group={group} locale={locale}>
                    {settings.map((setting) => {
                        const props: SettingProps = { setting, value: values[setting.key] ?? null, locale, onChange: (value) => change(setting.key, value) };
                        return group && (group.look === "dials" || group.look === "buttons") ? <SettingTile key={setting.key} look={group.look} {...props} /> : <SettingRow key={setting.key} {...props} />;
                    })}
                </SettingGroup>
            ))}
        </div>
    );
}

/**
 * The add-on's own view, for what its declared settings cannot draw (a preview,
 * never a control: those are declared settings, drawn below it). A frame
 * with scripts and nothing else (no same origin, so it reaches neither this
 * page nor its storage), served by the app from the installed package. It gets
 * the page's tokens, theme and locale when it is ready and again whenever one
 * of them changes while it is open, and every call it makes is read here and
 * judged by the app. It has no edge and no scrollbar of its own: its height is
 * the one it reports, so it reads as part of this page.
 */
export function AddonView({ bridge, manifest, view }: { bridge: AddonsBridge; manifest: AddonManifest; view: string }) {
    const t = useTranslations("account");
    const locale = useLocale();
    const frame = useRef<HTMLIFrameElement>(null);
    const [height, setHeight] = useState<number>(ADDON_VIEW_HEIGHT.min * 2);
    const viewCall = bridge.viewCall;
    // The hello is built from the latest locale, and sent again only when it differs
    // from the last one the view got, so an unrelated class on the root reaches nobody.
    const localeNow = useRef(locale);
    const ready = useRef(false);
    const lastHello = useRef("");
    const sendHello = useCallback((force: boolean) => {
        const target = frame.current?.contentWindow;
        if (!target || !ready.current) return;
        const hello = addonViewHello(localeNow.current, pageIsDark(), getComputedStyle(document.documentElement));
        const said = JSON.stringify(hello);
        if (!force && said === lastHello.current) return;
        lastHello.current = said;
        target.postMessage(hello, "*");
    }, []);

    useEffect(() => watchAddonViewLook(() => sendHello(false)), [sendHello]);
    useEffect(() => {
        localeNow.current = locale;
        sendHello(false);
    }, [locale, sendHello]);

    // Settings changed elsewhere (the list above, another window) reach an open view:
    // every change to the add-on brings a new manifest here, and the values are read again.
    const lastSettings = useRef("");
    const sendSettings = useCallback(() => {
        void bridge
            .settings(manifest.id)
            .then((values) => {
                const target = frame.current?.contentWindow;
                if (!values || !target || !ready.current) return;
                const said = JSON.stringify(values);
                if (said === lastSettings.current) return;
                lastSettings.current = said;
                target.postMessage({ type: "settings", values }, "*");
            })
            .catch(() => undefined);
    }, [bridge, manifest]);
    useEffect(() => sendSettings(), [sendSettings]);

    useEffect(() => {
        if (!viewCall) return;
        const target = () => frame.current?.contentWindow ?? null;
        const post = (message: unknown) => target()?.postMessage(message, "*");
        const heard = (event: MessageEvent) => {
            // Only its own frame; a sandboxed frame's origin is "null".
            if (!target() || event.source !== target()) return;
            const message = readAddonViewMessage(event.data);
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
                setHeight(addonViewHeight(message.height));
                return;
            }
            void viewCall(manifest.id, message.method, message.params)
                .then(readAddonViewReply, () => readAddonViewReply(null))
                .then((reply) => post({ type: "reply", id: message.id, ...reply }));
        };
        window.addEventListener("message", heard);
        return () => window.removeEventListener("message", heard);
    }, [viewCall, manifest.id, sendHello, sendSettings]);

    if (!viewCall) return null;
    return (
        <iframe
            ref={frame}
            src={addonViewUrl(manifest.id, view)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            title={say(t, "detail.view", { name: manifest.name })}
            scrolling="no"
            className="block w-full min-w-0 border-0 bg-transparent"
            style={{ height }}
        />
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm">{children}</dd>
        </div>
    );
}

export function AddonPage({ id }: { id: string }) {
    const t = useTranslations("account");
    const state = useAddons();
    const toast = useToast();
    const [confirm, confirmElement] = useConfirm();
    const bridge = state.kind === "ready" || state.kind === "loading" ? state.bridge : null;
    const [startInstall, installDialog] = useInstallFlow(bridge, state.kind === "ready" ? state.snapshot : null);

    const back = (
        <Link href="/account/addons" className="text-sm text-muted-foreground hover:underline">
            {say(t, "page.back")}
        </Link>
    );
    if (state.kind === "browser" || state.kind === "old-app") {
        return (
            <div className="flex min-w-0 flex-col gap-4">
                {back}
                <NotHere state={state} />
            </div>
        );
    }
    if (state.kind === "loading") {
        return (
            <div className="flex min-w-0 flex-col gap-4">
                {back}
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-40 w-full" />
            </div>
        );
    }
    const listing = addonListings(state.snapshot).find((item) => item.id === id) ?? null;
    const manifest = listing ? manifestOf(listing) : null;
    if (!listing || !manifest) {
        return (
            <div className="flex min-w-0 flex-col gap-4">
                {back}
                <Notice>{say(t, "detail.notFound")}</Notice>
            </div>
        );
    }
    const { entry, installed } = listing;
    const offer = addonOffer(state.snapshot, id, entry);
    const run = installed ? runLabel(t, installed) : null;
    const size = entry && state.snapshot.platform ? entry.packages[state.snapshot.platform]?.size : undefined;

    const uninstall = async () => {
        const ok = await confirm({ title: say(t, "detail.uninstallTitle", { name: manifest.name }), description: say(t, "detail.uninstallBody"), confirmLabel: say(t, "detail.uninstall"), danger: true });
        if (ok) await state.bridge.uninstall(id).catch(() => false);
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
        <div className="flex min-w-0 flex-col gap-5">
            {back}
            <header className="flex min-w-0 flex-wrap items-start gap-3">
                <AddonIcon entry={entry} size={56} />
                <div className="min-w-0 flex-1 basis-48">
                    <h1 className="truncate text-[1.0625rem] font-semibold tracking-tight" title={manifest.name}>
                        {manifest.name}
                    </h1>
                    <p className="truncate text-sm text-muted-foreground">{say(t, "card.by", { publisher: manifest.publisher })}</p>
                    {run ? (
                        <div className="mt-1">
                            <StatusBadge status={run.status} label={run.label} />
                        </div>
                    ) : null}
                    {run?.detail ? (
                        <p className="mt-1 text-sm text-muted-foreground">{run.detail}</p>
                    ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {offer.kind !== "installed" ? <OfferButton offer={offer} href={hrefOf(id)} size="md" onInstall={() => entry && startInstall(entry)} /> : null}
                    {installed ? (
                        <>
                            <Switch checked={installed.enabled} onChange={toggle} aria-label={say(t, "detail.enabled")} />
                            <Button variant="secondary" onClick={() => void uninstall()}>
                                {say(t, "detail.uninstall")}
                            </Button>
                        </>
                    ) : null}
                </div>
            </header>
            <OfficialSoftware id={id} bridge={state.bridge} />
            <p className="text-sm">{manifest.summary}</p>
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
            {installed ? <AutoUpdateRow bridge={state.bridge} snapshot={state.snapshot} id={id} /> : null}
            {installed && installed.manifest ? (
                <section className="flex min-w-0 flex-col gap-2" aria-label={say(t, "detail.settings")}>
                    <h2 className="text-sm font-medium text-muted-foreground">{say(t, "detail.settings")}</h2>
                    {installed.manifest.view ? <AddonView bridge={state.bridge} manifest={installed.manifest} view={installed.manifest.view} /> : null}
                    <AddonSettings bridge={state.bridge} manifest={installed.manifest} />
                </section>
            ) : null}
            {entry && entry.screenshots.length > 0 ? (
                <div className="flex min-w-0 gap-3 overflow-x-auto">
                    {entry.screenshots.map((url, index) => (
                        // eslint-disable-next-line @next/next/no-img-element -- a release asset, cached by the browser
                        <img key={url} src={url} loading="lazy" alt={say(t, "detail.screenshot", { name: manifest.name, number: index + 1 })} className="h-48 shrink-0 rounded-md border border-border" />
                    ))}
                </div>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label={say(t, "detail.version")}>{installed?.version ?? manifest.version}</Fact>
                <Fact label={say(t, "detail.size")}>{size ? formatBytes(size) : "-"}</Fact>
                <Fact label={say(t, "detail.published")}>{entry ? new Date(entry.published).toLocaleDateString() : "-"}</Fact>
                <Fact label={say(t, "detail.publisher")}>{manifest.publisher}</Fact>
            </dl>
            <section className="flex min-w-0 flex-col gap-1" aria-label={say(t, "detail.permissions")}>
                <h2 className="text-sm font-medium text-muted-foreground">{say(t, "detail.permissions")}</h2>
                {manifest.permissions.length === 0 ? (
                    <p className="text-sm">{say(t, "install.none")}</p>
                ) : (
                    <ul className="list-disc ps-5 text-sm">
                        {manifest.permissions.map((permission) => (
                            <li key={permission}>{say(t, `permission.${PERMISSION_KEY[permission]}`)}</li>
                        ))}
                    </ul>
                )}
            </section>
            {entry?.changelog ? (
                <section className="flex min-w-0 flex-col gap-1" aria-label={say(t, "detail.changelog")}>
                    <h2 className="text-sm font-medium text-muted-foreground">
                        {installed?.update ? say(t, "detail.changelogFor", { version: installed.update }) : say(t, "detail.changelog")}
                    </h2>
                    <p className="whitespace-pre-line text-sm">{entry.changelog}</p>
                </section>
            ) : null}
            {confirmElement}
            {installDialog}
        </div>
    );
}
