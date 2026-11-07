"use client";

/**
 * The marketplace, laid out as a store, and the per-app install wizard. The
 * catalog is imported directly (it is static and client-safe), so the whole
 * listing paints with the shell; the installed state and what this reader may
 * do come from the server with the page.
 *
 * - **Search, categories and a sort** above everything, the first thing
 *   somebody arriving with a name or a need in mind reaches for. What is shown
 *   and in what order is decided in `lib/apps/marketplace-store`.
 * - **A featured row** of apps that can be installed today and have a real
 *   capture to show, then the apps on two shelves: Polaris's own, and other
 *   developers' software Polaris installs.
 * - **Every card leads with one action** - Install, Installing, Open, or why
 *   not - and a small badge for how its install is doing. Configure, Details
 *   and Uninstall live in the card's overflow menu instead of a row of buttons
 *   that all look equally important.
 * - **Installed lists apps, not their parts.** A camera relay and six Minecraft
 *   servers are what two apps run, not eight installs (`internal`, `ownedBy`).
 *
 * The catalog is a dozen apps, so the grid is drawn whole: there is nothing
 * here a virtualized list or a second page would save.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpCircle, Loader2, Search, Store } from "lucide-react";
import { AppMark } from "@/components/app-mark";
import { CAPABILITY_KEYS } from "@/lib/apps/capability-words";
import { appSettingsHref, builtInSettingsHref } from "@/lib/apps/app-settings";
import { APP_CATEGORIES, resolveActiveApp } from "@/lib/apps";
import { useLocalizeStoreApp } from "./use-store-words";
import { TemplateDeployDialog } from "./template-deploy-dialog";
import { BuiltInAlternativeNote } from "./built-in-alternative";
import { UninstallDialog } from "./uninstall-dialog";
import { appProvenance } from "@/lib/apps/provenance";
import { appPreview, builtInPreview } from "@/lib/apps/app-screenshots";
import {
    canUpdate,
    newerBuild,
    useAppUpdates,
    type AppUpdates
} from "@/components/app-bundles/use-app-updates";
import {
    CardUpdateButton,
    CardUpdateNote,
    leadsWithUpdate,
    type CardUpdateState
} from "./store-card-update";
import { defaultInstallInput } from "@/lib/apps/install-defaults";
import { useEffect, useMemo, useState, useTransition } from "react";
import type { InstalledAppReaderView } from "@/lib/apps/install-service";
import { appInstallInputSchema, NAS_CONNECTION_REQUIRED } from "@/lib/apps/install-schema";
import { findApp, promptedEnvVars, type AppManifest } from "@/lib/apps/catalog";
import { NATIVE_APPS, NATIVE_APP_IDS } from "@/lib/apps/native-apps";
import {
    POLARIS_APPS_PATH,
    STORE_SORTS,
    builtInApps,
    builtInHref,
    storeApps,
    featuredApps,
    listingHref,
    storeScope,
    filterStoreApps,
    installBadge,
    primaryAction,
    storeCategories,
    storeShelves,
    type StoreCategory,
    type StoreScope,
    type StoreShelf,
    type StoreSort
} from "@/lib/apps/marketplace-store";
import { ServerPicker } from "@/components/server-picker";
import { LOCAL_SERVER_OPTION } from "@/lib/server-options-schema";
import { installAppAction, type StorageConnectionOption } from "./actions";
import {
    AppPreview,
    BuiltInMark,
    BuiltInPreview,
    OverflowMenu,
    PrimaryActionButton,
    StatusBadge,
    useBuiltInListing,
    type BuiltInListing,
    type OverflowEntry
} from "./store-card";
import * as store from "@polaris/ui/store-card";
import {
    Badge,
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    PageHeader,
    Select
} from "@polaris/ui";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { categoryLabel } from "@/lib/apps/app-words";
import { validationMessage } from "@/components/i18n/validation-message";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import * as polls from "./marketplace-polls";

type Words = NamespaceTranslator<"marketplace">;

/** An install's state, said as `statuses.<status>`; one a newer service adds shows as it came. */
const STATUSES = new Set(["installing", "running", "stopped", "failed"]);

export function statusLabel(t: Words, status: string): string {
    return STATUSES.has(status) ? t(`statuses.${status}` as NamespaceKey<"marketplace">) : status;
}

/** An install as the grid is handed it, with whether this reader may uninstall it
 *  (`uninstallAccess`, the check the uninstall action makes). */
export type StoreInstallRow = InstalledAppReaderView & { readonly canUninstall?: boolean };

export function MarketplaceView({
    installed,
    initialQuery = "",
    canInstall = false,
    scope = "deployable",
    canBrowsePolaris = false,
    openableBuiltIns = [],
    canUpdateApps = false
}: {
    installed: StoreInstallRow[];
    /** What the search starts with - an app's name, when a screen sent somebody
     *  here to install that app. */
    initialQuery?: string;
    /** deploy.manage, the permission the install action requires. */
    canInstall?: boolean;
    /** Which marketplace this is: deployable apps (/apps/marketplace) or
     *  Polaris's own (/admin/apps). Each lists only its own apps. */
    scope?: StoreScope;
    /** Whether the reader may open the admin screen, for the way there from an
     *  empty user marketplace. */
    canBrowsePolaris?: boolean;
    /** Addresses of the built-in screens this reader may open, for the note on
     *  a template whose job one of them already does (see
     *  `BuiltInAlternativeNote`). */
    openableBuiltIns?: readonly string[];
    /** Whether the reader may update Polaris's own apps - the check the update
     *  action makes. Only the Polaris apps screen asks for their builds. */
    canUpdateApps?: boolean;
}) {
    const t = useTranslations("marketplace");
    const tc = useTranslations("components");
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const [wizardApp, setWizardApp] = useState<AppManifest | null>(null);
    const [deploying, setDeploying] = useState<AppManifest | null>(null);
    const [removing, setRemoving] = useState<StoreInstallRow | null>(null);
    const [query, setQuery] = useState(initialQuery);
    const [category, setCategory] = useState<StoreCategory>("all");
    const [sort, setSort] = useState<StoreSort>("featured");

    // In the reader's words, so the cards and the search say what they read. An
    // app or a category named after a screen takes the rail's label for it.
    const localize = useLocalizeStoreApp();
    const all = useMemo(
        () =>
            storeApps()
                .filter((app) => storeScope(app) === scope)
                .map(localize),
        [localize, scope]
    );
    const categories = useMemo(() => storeCategories(all), [all]);
    const shown = useMemo(
        () => filterStoreApps(all, { query, category, sort, locale }),
        [all, query, category, sort, locale]
    );
    const browsing = !query.trim() && category === "all";
    const featured = useMemo(() => (browsing ? featuredApps(all) : []), [all, browsing]);

    // The apps every Polaris comes with, as cards in the same grid as the ones an
    // administrator switches on, found by the same search. Their categories are
    // the switcher's, not the store's, so they leave the grid while one is picked.
    const toListing = useBuiltInListing();
    const builtIns = useMemo((): BuiltInListing[] => {
        if (scope !== "polaris" || category !== "all") return [];
        const needle = query.trim().toLocaleLowerCase(locale);
        const listed = builtInApps()
            .map(toListing)
            .filter(
                (entry) =>
                    !needle ||
                    `${entry.name} ${entry.summary}`.toLocaleLowerCase(locale).includes(needle)
            );
        return sort === "name"
            ? listed.sort((a, b) => a.name.localeCompare(b.name, locale))
            : listed;
    }, [scope, query, category, sort, locale, toListing]);

    // Polaris's own apps update on their own, and their cards say so the way a
    // phone's store does. Asked after the grid has painted, and only by a reader
    // the update action would answer.
    const asksUpdates = scope === "polaris" && canUpdateApps;
    const updates = useAppUpdates({ enabled: asksUpdates });
    const [retrying, startRetry] = useTransition();
    const listed = useMemo(() => new Set(all.map((app) => app.id)), [all]);
    const updatableIds = useMemo(
        () => (asksUpdates ? new Set([...listed, ...NATIVE_APP_IDS]) : listed),
        [asksUpdates, listed]
    );
    const updatable = (updates.rows ?? []).filter(
        (row) => updatableIds.has(row.id) && canUpdate(row)
    );
    const updateState = (id: string): CardUpdateState => cardUpdateState(updates, id);
    const updateFor = (
        app: AppManifest,
        installs: StoreInstallRow[]
    ): CardUpdateState | undefined =>
        asksUpdates && installs.length > 0 ? updateState(app.id) : undefined;
    // Security scans and Cloud servers run inside a built-in app's screens, so
    // their updates show on that app's card.
    const nativeUpdatesFor = (entry: BuiltInListing): NativeUpdate[] =>
        asksUpdates ? builtInNativeUpdates(entry.id, updates, localize) : [];

    // The Polaris apps screen draws every app as a card, installed or not, so
    // its Installed rows are only for an install no card stands for: one of
    // several of the same app, which the card counts but cannot open.
    const rows = useMemo(
        () =>
            scope === "polaris"
                ? installed.filter(
                      (item) => !listed.has(item.catalogId) || !findApp(item.catalogId)?.singleton
                  )
                : installed,
        [installed, listed, scope]
    );

    const { install, installingId, error } = useOneClickInstall();
    const openable = useMemo(() => new Set(openableBuiltIns), [openableBuiltIns]);

    const installsByCatalog = useMemo(() => {
        const map = new Map<string, StoreInstallRow[]>();
        for (const item of installed)
            map.set(item.catalogId, [...(map.get(item.catalogId) ?? []), item]);
        return map;
    }, [installed]);

    const card = (app: AppManifest, featuredCard = false) => (
        <StoreCard
            key={app.id}
            app={app}
            installs={installsByCatalog.get(app.id) ?? []}
            update={updateFor(app, installsByCatalog.get(app.id) ?? [])}
            canInstall={canInstall}
            installing={installingId === app.id}
            disabled={installingId !== null}
            featured={featuredCard}
            openable={openable}
            settingsHref={scope === "polaris" ? appSettingsHref(app) : null}
            onInstall={() => (app.deployTemplate ? setDeploying(app) : install(app))}
            onConfigure={() => setWizardApp(app)}
            onUninstall={setRemoving}
        />
    );

    const header = (
        <PageHeader
            title={scope === "polaris" ? t("polaris.title") : t("view.title")}
            description={scope === "polaris" ? t("polaris.description") : t("view.description")}
        />
    );

    // Nothing is offered here at all, so a search box and categories would only
    // be a way to find out the same thing more slowly.
    if (all.length === 0 && installed.length === 0)
        return (
            <div className="flex min-w-0 flex-col gap-6">
                {header}
                <EmptyState
                    icon={<Store />}
                    title={t("view.empty.title")}
                    description={t("view.empty.body")}
                    action={
                        canBrowsePolaris ? (
                            <Button asChild size="sm" variant="secondary">
                                <Link href={POLARIS_APPS_PATH}>{t("view.empty.polaris")}</Link>
                            </Button>
                        ) : null
                    }
                />
            </div>
        );

    return (
        <div className="flex min-w-0 flex-col gap-6">
            {header}

            <div className="flex min-w-0 flex-col gap-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <div className="relative min-w-0 flex-1 basis-60 sm:max-w-md">
                        <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2" />
                        <Input
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t("view.search")}
                            aria-label={t("view.search")}
                            className="pl-8"
                        />
                    </div>
                    <Select
                        value={sort}
                        onValueChange={(value) => setSort(value as StoreSort)}
                        aria-label={t("view.sortLabel")}
                        className="w-44"
                        options={STORE_SORTS.map((value) => ({
                            value,
                            label: t(`view.sort.${value}`)
                        }))}
                    />
                </div>
                <div
                    role="group"
                    aria-label={t("view.categories")}
                    className="flex min-w-0 flex-wrap gap-1.5"
                >
                    {(["all", ...categories] as StoreCategory[]).map((value) => (
                        <Button
                            key={value}
                            size="sm"
                            variant={category === value ? "primary" : "secondary"}
                            aria-pressed={category === value}
                            onClick={() => setCategory(value)}
                        >
                            {value === "all"
                                ? t("view.allCategories")
                                : categoryLabel(words, value, navLabel)}
                        </Button>
                    ))}
                </div>
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {updatable.length > 0 && (
                <div
                    role="status"
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-4 py-3"
                >
                    <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <ArrowUpCircle
                            className="size-4 shrink-0 text-primary"
                            aria-hidden="true"
                        />
                        <span className="truncate">
                            {tc("appUpdates.updatesAvailable", { count: updatable.length })}
                        </span>
                    </p>
                    <Button
                        size="sm"
                        disabled={updates.busy !== null}
                        aria-busy={updates.busy !== null || undefined}
                        onClick={() => void updates.updateAll(updatableIds)}
                    >
                        {updates.busy !== null
                            ? tc("appUpdates.updating")
                            : tc("appUpdates.updateAll")}
                    </Button>
                </div>
            )}

            {asksUpdates && updates.failed && (
                <div
                    role="alert"
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-md bg-muted/40 px-4 py-3"
                >
                    <p className="min-w-0 truncate text-sm text-danger">
                        {tc("appUpdates.checkFailed")}
                    </p>
                    <Button
                        size="sm"
                        variant="secondary"
                        disabled={retrying}
                        aria-busy={retrying || undefined}
                        onClick={() =>
                            startRetry(async () => {
                                await updates.load(true);
                            })
                        }
                    >
                        {tc("appUpdates.check")}
                    </Button>
                </div>
            )}

            {browsing && rows.length > 0 && (
                <InstalledSection installed={rows} onUninstall={setRemoving} />
            )}

            {featured.length > 0 && (
                <section className="flex min-w-0 flex-col gap-3" aria-label={t("view.featured")}>
                    <h2 className="text-sm font-medium text-muted-foreground">
                        {t("view.featured")}
                    </h2>
                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                        {featured.map((app) => card(app, true))}
                    </div>
                </section>
            )}

            {shown.length === 0 && builtIns.length === 0 ? (
                <p className="text-muted-foreground py-10 text-center text-sm">
                    {t("view.noMatch")}
                </p>
            ) : (
                shelvesWith(storeShelves(shown), builtIns.length > 0).map((group) => (
                    <section
                        key={group.shelf}
                        className="flex min-w-0 flex-col gap-3"
                        aria-label={t(`view.shelves.${group.shelf}`)}
                    >
                        <h2 className="text-sm font-medium text-muted-foreground">
                            {t(`view.shelves.${group.shelf}`)}
                        </h2>
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                            {group.apps.map((app) => card(app))}
                            {group.shelf === "polaris" &&
                                builtIns.map((entry) => (
                                    <div
                                        key={`built-in:${entry.id}`}
                                        data-built-in={entry.id}
                                        className="min-w-0"
                                    >
                                        <BuiltInCard
                                            entry={entry}
                                            updates={nativeUpdatesFor(entry)}
                                        />
                                    </div>
                                ))}
                        </div>
                    </section>
                ))
            )}

            {wizardApp && <InstallWizard app={wizardApp} onClose={() => setWizardApp(null)} />}
            {deploying?.deployTemplate && (
                <TemplateDeployDialog
                    templateId={deploying.deployTemplate}
                    name={deploying.name}
                    onClose={() => setDeploying(null)}
                />
            )}
            {removing && <UninstallDialog install={removing} onClose={() => setRemoving(null)} />}
        </div>
    );
}

/**
 * One click installs the app the way its manifest describes it: on this server,
 * with its own defaults, and it opens on the app afterwards. Anyone who wants a
 * different server or NAS-backed storage has Configure, which is the same
 * install with the choices exposed. The grid and an app's own page share it.
 */
export function useOneClickInstall(): {
    install: (app: AppManifest) => void;
    installingId: string | null;
    error: string | null;
} {
    const t = useTranslations("marketplace");
    const router = useRouter();
    const [installingId, setInstallingId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    function install(app: AppManifest): void {
        setError(null);
        setInstallingId(app.id);
        // The manifest as declared: the card is in the reader's words, the install
        // is the same in every language.
        void installAppAction(defaultInstallInput(findApp(app.id) ?? app))
            .then((result) => {
                if (result.error || !result.installedAppId) {
                    setError(result.error ?? t("errors.install"));
                    setInstallingId(null);
                    return;
                }
                // An app that opens somewhere of its own usually adds itself to the
                // switcher or a rail, and those are drawn by the layout - which a
                // client navigation keeps. A full load brings them along.
                if (app.opensAt) window.location.assign(app.opensAt);
                else router.push(`/apps/installed/${result.installedAppId}`);
            })
            .catch(() => {
                setError(t("errors.install"));
                setInstallingId(null);
            });
    }

    return { install, installingId, error };
}

/**
 * The apps somebody has installed - the apps, not the containers they run.
 *
 * A camera relay, a face recognizer and six Minecraft servers are not eight
 * things anybody installed: they are what Places and Game servers run, and every
 * one of them was appearing here as an independent app with its own card. The
 * manifests have said so all along (`internal`, and `ownedBy` naming the app that
 * creates them); this screen was the one place not reading it.
 *
 * An install whose manifest is gone entirely is still shown. It is on somebody's
 * server, and hiding it because the catalog no longer describes it is how a
 * container becomes unreachable from the product that started it.
 */
function ownInstalls<T extends InstalledAppReaderView>(installed: readonly T[]): T[] {
    return installed.filter((item) => {
        const manifest = findApp(item.catalogId);
        return !manifest || !manifest.internal;
    });
}

function InstalledSection({
    installed,
    onUninstall
}: {
    installed: StoreInstallRow[];
    onUninstall: (item: StoreInstallRow) => void;
}) {
    const t = useTranslations("marketplace");
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    const router = useRouter();
    const own = ownInstalls(installed);
    if (own.length === 0) return null;

    return (
        <section className="flex min-w-0 flex-col gap-3" aria-label={t("view.installed")}>
            <h2 className="text-sm font-medium text-muted-foreground">{t("view.installed")}</h2>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {own.map((item) => {
                    const manifest = findApp(item.catalogId);
                    const href = manifest?.opensAt ?? `/apps/installed/${item.id}`;
                    const badge = manifest ? installBadge(manifest, [item]) : null;
                    const entries: OverflowEntry[] = [];
                    if (manifest)
                        entries.push({
                            key: "details",
                            label: t("card.details"),
                            onSelect: () => router.push(listingHref(manifest))
                        });
                    // Offered from the same check the uninstall action makes, so a
                    // reader the server would refuse is never shown it.
                    if (item.canUninstall)
                        entries.push({
                            key: "uninstall",
                            label: t("uninstall.confirm"),
                            danger: true,
                            onSelect: () => onUninstall(item)
                        });
                    return (
                        <div
                            key={item.id}
                            className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                        >
                            {manifest ? (
                                <AppMark app={manifest} size={36} />
                            ) : (
                                <div className="border-border bg-surface grid size-9 shrink-0 place-items-center rounded-md" />
                            )}
                            <div className="min-w-0 flex-1">
                                <Link
                                    href={href}
                                    className="block truncate text-sm font-medium hover:underline"
                                    title={item.name}
                                >
                                    {item.name}
                                </Link>
                                <div className="flex min-w-0 items-center gap-1.5">
                                    <span className="truncate text-xs text-muted-foreground">
                                        {manifest
                                            ? categoryLabel(words, manifest.category, navLabel)
                                            : item.catalogId}
                                    </span>
                                    {badge?.kind === "status" && (
                                        <StatusBadge
                                            status={item.status}
                                            label={statusLabel(t, item.status)}
                                        />
                                    )}
                                </div>
                            </div>
                            <Button asChild size="sm" variant="secondary">
                                <Link href={href}>{t("card.open")}</Link>
                            </Button>
                            <OverflowMenu
                                label={t("card.more", { name: item.name })}
                                entries={entries}
                            />
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

/** A switcher category's English label, translated where it is drawn (`useNavLabel`). */
export function switcherCategory(id: string): string {
    return APP_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

/** The shelves, with the Polaris one kept when only built-in apps match. */
function shelvesWith(
    shelves: Array<{ shelf: StoreShelf; apps: AppManifest[] }>,
    builtIns: boolean
): Array<{ shelf: StoreShelf; apps: AppManifest[] }> {
    if (!builtIns || shelves.some((group) => group.shelf === "polaris")) return shelves;
    return [{ shelf: "polaris", apps: [] }, ...shelves];
}

/** One app's update as its card reads it, from the rows `useAppUpdates` answers. */
export function cardUpdateState(updates: AppUpdates, id: string): CardUpdateState {
    return {
        loading: updates.rows === null && !updates.failed,
        row: updates.rows?.find((row) => row.id === id) ?? null,
        busy: updates.busy === id,
        locked: updates.busy !== null,
        refused: updates.refusals[id],
        onUpdate: () => void updates.change(id, "update")
    };
}

/** A native app's update, on the built-in app whose screens it runs in. */
export interface NativeUpdate {
    readonly id: string;
    readonly name: string;
    readonly state: CardUpdateState;
}

/** The native apps that run inside a built-in app's screens, with their updates. */
export function builtInNativeUpdates(
    entryId: string,
    updates: AppUpdates,
    localize: (app: AppManifest) => AppManifest
): NativeUpdate[] {
    return NATIVE_APP_IDS.filter(
        (id) => resolveActiveApp(NATIVE_APPS[id] ?? "").id === entryId
    ).map((id) => {
        const app = findApp(id);
        return { id, name: app ? localize(app).name : id, state: cardUpdateState(updates, id) };
    });
}

export function NativeUpdateNote({ update }: { update: NativeUpdate }) {
    const { row, busy, refused } = update.state;
    if (!busy && !refused && !(row && (newerBuild(row) || row.checkFailed))) return null;
    return (
        <div data-native-update={update.id} className="flex min-w-0 items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <p className="truncate text-xs text-muted-foreground" title={update.name}>
                    {update.name}
                </p>
                <CardUpdateNote state={update.state} />
            </div>
            {leadsWithUpdate(update.state) && <CardUpdateButton state={update.state} />}
        </div>
    );
}

/**
 * An app every Polaris comes with, on the same card as the ones an
 * administrator switches on. Nothing installs it, so nothing can remove it: the
 * menu still lists Uninstall, switched off with the reason, so a reader looking
 * for it learns why rather than wondering where it went.
 */
function BuiltInCard({
    entry,
    updates = []
}: {
    entry: BuiltInListing;
    updates?: readonly NativeUpdate[];
}) {
    const t = useTranslations("marketplace");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const router = useRouter();
    const settingsHref = builtInSettingsHref(entry.id);
    const detailHref = builtInHref(entry.id);
    const entries: OverflowEntry[] = [
        { key: "details", label: t("card.details"), onSelect: () => router.push(detailHref) }
    ];
    if (settingsHref)
        entries.push({
            key: "settings",
            label: t("detail.settings"),
            onSelect: () => router.push(settingsHref)
        });
    entries.push({
        key: "uninstall",
        label: t("uninstall.confirm"),
        hint: t("polaris.cannotUninstall"),
        disabled: true,
        onSelect: () => undefined
    });
    return (
        <store.StoreCard
            preview={
                <Link
                    href={detailHref}
                    tabIndex={-1}
                    aria-hidden
                    className="block border-b border-border"
                >
                    <BuiltInPreview entry={entry} shot={builtInPreview(entry.id, locale)} />
                </Link>
            }
            mark={<BuiltInMark entry={entry} size={40} />}
            title={
                <Link
                    href={detailHref}
                    className="block truncate text-sm font-medium hover:underline"
                    title={entry.name}
                >
                    {entry.name}
                </Link>
            }
            byline={t("polaris.builtInBy")}
            summary={entry.summary}
            note={
                updates.length > 0 ? (
                    <>
                        {updates.map((update) => (
                            <NativeUpdateNote key={update.id} update={update} />
                        ))}
                    </>
                ) : undefined
            }
            badges={<Badge>{navLabel(switcherCategory(entry.category))}</Badge>}
            status={<Badge>{t("polaris.builtIn")}</Badge>}
            actions={
                <>
                    <Button asChild size="sm">
                        <Link href={entry.href}>{t("card.open")}</Link>
                    </Button>
                    <OverflowMenu label={t("card.more", { name: entry.name })} entries={entries} />
                </>
            }
        />
    );
}

/**
 * One line naming who is behind an app.
 *
 * Both halves when they differ - somebody else's software in somebody else's
 * container is two facts and a reader deciding whether to run it wants both - and
 * one when they do not, because "Polaris - published by Polaris" says nothing
 * twice.
 */
export function by(t: Words, from: { developer: string; distributor: string }): string {
    return from.developer === from.distributor
        ? t("card.by", { developer: from.developer })
        : t("card.byImage", { developer: from.developer, distributor: from.distributor });
}

function StoreCard({
    app,
    installs,
    update,
    canInstall,
    installing,
    disabled,
    featured,
    openable,
    settingsHref,
    onInstall,
    onConfigure,
    onUninstall
}: {
    app: AppManifest;
    installs: StoreInstallRow[];
    /** Its build and any newer one, on the Polaris apps screen once it is installed. */
    update?: CardUpdateState;
    canInstall: boolean;
    installing: boolean;
    /** Another install is running; one at a time keeps the target's deploy queue
     *  and this page's feedback honest. */
    disabled: boolean;
    featured: boolean;
    openable: ReadonlySet<string>;
    /** Where an administrator changes how the app works here, for an app that
     *  has such settings, offered once it is installed. */
    settingsHref: string | null;
    onInstall: () => void;
    onConfigure: () => void;
    onUninstall: (item: StoreInstallRow) => void;
}) {
    const t = useTranslations("marketplace");
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    const locale = useLocale();
    const router = useRouter();
    // Who made it and who ships the image, read off what the app installs rather
    // than typed in - see `appProvenance`.
    const from = appProvenance(app);
    const action = primaryAction(app, { installs, canInstall, installing });
    const badge = installBadge(app, installs);
    const detailHref = listingHref(app);

    // Update takes the place Open had, as a phone's store does; Open moves into the menu.
    const updateFirst = leadsWithUpdate(update);
    const entries: OverflowEntry[] = [];
    if (updateFirst && action.kind === "open")
        entries.push({
            key: "open",
            label: t("card.open"),
            onSelect: () => router.push(action.href)
        });
    entries.push({
        key: "details",
        label: t("card.details"),
        onSelect: () => router.push(detailHref)
    });
    if (settingsHref && installs.length > 0)
        entries.push({
            key: "settings",
            label: t("detail.settings"),
            onSelect: () => router.push(settingsHref)
        });
    if (action.kind === "install" && action.configurable)
        entries.push({
            key: "configure",
            label: t("card.configure"),
            onSelect: onConfigure,
            disabled
        });
    const removable = app.singleton ? installs[0] : undefined;
    if (removable?.canUninstall)
        entries.push({
            key: "uninstall",
            label: t("uninstall.confirm"),
            danger: true,
            onSelect: () => onUninstall(removable)
        });

    return (
        <store.StoreCard
            muted={app.comingSoon}
            featured={featured}
            preview={
                // The name below is the link a keyboard reaches; the picture is
                // the same destination for a pointer.
                <Link
                    href={detailHref}
                    tabIndex={-1}
                    aria-hidden
                    className="block border-b border-border"
                >
                    <AppPreview app={app} shot={appPreview(app.id, locale)} eager={featured} />
                </Link>
            }
            mark={<AppMark app={app} size={40} />}
            title={
                <Link
                    href={detailHref}
                    className="block truncate text-sm font-medium hover:underline"
                    title={app.name}
                >
                    {app.name}
                </Link>
            }
            byline={by(t, from)}
            summary={app.summary}
            badges={
                <>
                    <Badge>{categoryLabel(words, app.category, navLabel)}</Badge>
                    {app.capabilities.map((capability) => (
                        <Badge key={capability} className="text-muted-foreground">
                            {t(CAPABILITY_KEYS[capability])}
                        </Badge>
                    ))}
                </>
            }
            note={
                <>
                    {update && <CardUpdateNote state={update} />}
                    <BuiltInAlternativeNote app={app} openable={openable} />
                    {app.consent && (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("card.consent", {
                                label: app.consent.label,
                                link: (chunks) => (
                                    <a
                                        key="consent"
                                        href={app.consent?.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline underline-offset-2 hover:text-foreground"
                                    >
                                        {chunks}
                                    </a>
                                )
                            })}
                        </p>
                    )}
                </>
            }
            status={
                <>
                    {badge?.kind === "status" && (
                        <StatusBadge status={badge.status} label={statusLabel(t, badge.status)} />
                    )}
                    {badge?.kind === "installed" && <Badge>{t("card.installed")}</Badge>}
                    {!app.singleton && installs.length > 0 && (
                        <span className="truncate text-xs text-muted-foreground">
                            {t("card.installedCount", { count: installs.length })}
                        </span>
                    )}
                </>
            }
            actions={
                <>
                    {updateFirst && update ? (
                        <CardUpdateButton state={update} />
                    ) : (
                        <PrimaryActionButton
                            action={action}
                            onInstall={onInstall}
                            disabled={disabled}
                        />
                    )}
                    <OverflowMenu label={t("card.more", { name: app.name })} entries={entries} />
                </>
            }
        />
    );
}

export function InstallWizard({ app, onClose }: { app: AppManifest; onClose: () => void }) {
    const t = useTranslations("marketplace");
    const tvalidation = useTranslations("validation");
    const tcommon = useTranslations("common");
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const template = app.template;
    const volumes = template?.volumes ?? [];
    // Only what an operator answers: the generated credentials and the licence the
    // install itself accepts are not fields.
    const envFields = promptedEnvVars(app);

    const [name, setName] = useState(app.name);
    const [serverId, setServerId] = useState(LOCAL_SERVER_OPTION);
    const [connections, setConnections] = useState<StorageConnectionOption[]>([]);
    const [storage, setStorage] = useState<
        Record<string, { backing: "local" | "nas"; connectionId?: string }>
    >(() =>
        Object.fromEntries(volumes.map((volume) => [volume.name, { backing: "local" as const }]))
    );
    const [env, setEnv] = useState<Record<string, string>>(() =>
        Object.fromEntries(envFields.map((field) => [field.key, field.default ?? ""]))
    );
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        void polls
            .storageConnections()
            .then((loadedConnections) => {
                if (active) setConnections(loadedConnections);
            })
            .catch(() => active && setError(t("errors.storage")));
        return () => {
            active = false;
        };
    }, [t]);

    function submit() {
        setError(null);
        const input = {
            catalogId: app.id,
            name,
            serverId,
            storage: volumes.map((volume) => {
                const choice = storage[volume.name];
                return {
                    volumeName: volume.name,
                    backing: choice?.backing ?? "local",
                    connectionId: choice?.backing === "nas" ? choice.connectionId : undefined
                };
            }),
            env: envFields.map((field) => ({
                key: field.key,
                value: env[field.key] ?? field.default ?? ""
            }))
        };
        const parsed = appInstallInputSchema.safeParse(input);
        if (!parsed.success) {
            const message = parsed.error.issues[0]?.message;
            setError(
                !message
                    ? t("errors.checkForm")
                    : message === NAS_CONNECTION_REQUIRED
                      ? t("errors.chooseNas")
                      : validationMessage(tvalidation, message)
            );
            return;
        }
        startTransition(async () => {
            const result = await installAppAction(parsed.data);
            if (result.error || !result.installedAppId) {
                setError(result.error ?? t("errors.install"));
                return;
            }
            // Land on the app that was just installed, the way installing from the
            // card does - it is deploying, and its page is where that is visible.
            router.push(`/apps/installed/${result.installedAppId}`);
        });
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <AppMark app={app} size={22} /> {t("wizard.title", { name: app.name })}
                    </DialogTitle>
                    <DialogDescription>{app.description}</DialogDescription>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("wizard.name")}</span>
                        <Input
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder={t("wizard.namePlaceholder")}
                        />
                    </label>

                    <label className="flex flex-col gap-1 text-sm">
                        <span className="font-medium">{t("wizard.server")}</span>
                        <ServerPicker
                            value={serverId}
                            onValueChange={setServerId}
                            selectedLabel={
                                serverId === LOCAL_SERVER_OPTION
                                    ? t("wizard.thisServer")
                                    : undefined
                            }
                            includeLocal
                            placeholder={t("wizard.chooseServer")}
                            aria-label={t("wizard.server")}
                        />
                    </label>

                    {volumes.length > 0 && (
                        <div className="flex flex-col gap-3">
                            <span className="text-sm font-medium">{t("wizard.storage")}</span>
                            {volumes.map((volume) => {
                                const choice = storage[volume.name] ?? {
                                    backing: "local" as const
                                };
                                return (
                                    <div
                                        key={volume.name}
                                        className="flex flex-col gap-2 rounded-md border border-border p-3"
                                    >
                                        <span className="text-sm">{volume.label}</span>
                                        <Select
                                            value={choice.backing}
                                            onValueChange={(value) =>
                                                setStorage((current) => ({
                                                    ...current,
                                                    [volume.name]: {
                                                        backing: value as "local" | "nas"
                                                    }
                                                }))
                                            }
                                            options={[
                                                { value: "local", label: t("wizard.thisServer") },
                                                { value: "nas", label: "NAS" } // i18n-ignore the same word in both languages
                                            ]}
                                        />
                                        {choice.backing === "nas" &&
                                            (connections.length > 0 ? (
                                                <Select
                                                    value={choice.connectionId ?? ""}
                                                    onValueChange={(value) =>
                                                        setStorage((current) => ({
                                                            ...current,
                                                            [volume.name]: {
                                                                backing: "nas",
                                                                connectionId: value
                                                            }
                                                        }))
                                                    }
                                                    placeholder={t("wizard.chooseNas")}
                                                    options={connections.map((connection) => ({
                                                        value: connection.id,
                                                        label: connection.name
                                                    }))}
                                                />
                                            ) : (
                                                <p className="text-xs text-muted-foreground">
                                                    {t("wizard.noNas")}
                                                </p>
                                            ))}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    {envFields.length > 0 && (
                        <div className="flex flex-col gap-3">
                            <span className="text-sm font-medium">{t("wizard.configuration")}</span>
                            {envFields.map((field) => (
                                <label key={field.key} className="flex flex-col gap-1 text-sm">
                                    <span>{field.label}</span>
                                    {field.options ? (
                                        <Select
                                            value={env[field.key] ?? field.default ?? ""}
                                            onValueChange={(value) =>
                                                setEnv((current) => ({
                                                    ...current,
                                                    [field.key]: value
                                                }))
                                            }
                                            options={field.options}
                                        />
                                    ) : (
                                        <Input
                                            type={field.secret ? "password" : "text"}
                                            value={env[field.key] ?? ""}
                                            onChange={(event) =>
                                                setEnv((current) => ({
                                                    ...current,
                                                    [field.key]: event.target.value
                                                }))
                                            }
                                        />
                                    )}
                                    {field.help && (
                                        <span className="text-xs text-muted-foreground">
                                            {field.help}
                                        </span>
                                    )}
                                </label>
                            ))}
                        </div>
                    )}

                    {error && <p className="text-sm text-danger">{error}</p>}

                    {app.consent && (
                        <p className="text-xs text-muted-foreground">
                            {t.rich("card.consent", {
                                label: app.consent.label,
                                link: (chunks) => (
                                    <a
                                        key="consent"
                                        href={app.consent?.url}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="underline underline-offset-2 hover:text-foreground"
                                    >
                                        {chunks}
                                    </a>
                                )
                            })}
                        </p>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={onClose} disabled={pending}>
                            {tcommon("actions.cancel")}
                        </Button>
                        <Button onClick={submit} disabled={pending || !serverId}>
                            {pending && <Loader2 className="size-4 animate-spin" />}
                            {t("card.install")}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
