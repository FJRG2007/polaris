/**
 * What the Marketplace shows and in what order, decided apart from how it is
 * drawn: the category filter, the sort, the two shelves, the featured row, and
 * the one action each card leads with. Pure and client-safe, so the grid, an
 * app's own page and the tests all read the same answers.
 */

import { POLARIS_APPS, type AppEntry } from "@/lib/apps";
import { appReplaces } from "@/lib/apps/replaces";
import { appProvenance } from "@/lib/apps/provenance";
import { hasScreenshots } from "@/lib/apps/app-screenshots";
import { searchItems, type SearchField } from "@polaris/core/search-text";
import { findTemplateApp, templateApps } from "@/lib/apps/template-apps";
import {
    appsByCategory,
    findApp,
    isInstallable,
    type AppCategory,
    type AppManifest
} from "@/lib/apps/catalog";

/** How the grid is ordered. `featured` is the catalog's own, deliberate order. */
export type StoreSort = "featured" | "name" | "recent";

export const STORE_SORTS: readonly StoreSort[] = ["featured", "name", "recent"];

/** A category, or every one of them. */
export type StoreCategory = AppCategory | "all";

/** Who an app comes from: Polaris itself, or somebody else's software. */
export type StoreShelf = "polaris" | "community";

/**
 * The day each app entered the catalog, read off the git history of
 * `lib/apps/catalog.ts` (the first commit that declares its id). It is what
 * "Recently added" sorts by; an app missing here sorts after every dated one.
 */
export const ADDED_ON: Readonly<Record<string, string>> = {
    "messaging-bridge": "2026-07-23",
    openclaw: "2026-07-23",
    hermes: "2026-07-23",
    "game-servers": "2026-08-12",
    home: "2026-08-17",
    tools: "2026-09-09",
    "mail-server": "2026-09-11",
    calendar: "2026-10-01",
    crm: "2026-10-09",
    "status-pages": "2026-10-15",
    "dns-blocker": "2026-10-18"
};

/**
 * What a store search reads of an app: the name, the summary and the category,
 * weighted in that order - people search a store for a name, occasionally for
 * what a thing does, and the category is the tie-break rather than the answer.
 * The description is left out: matching inside a paragraph puts apps at the top
 * for a word buried in their third sentence. The manifest's keywords are read
 * for the kind of thing an app is when its own name is not it.
 */
const APP_FIELDS: readonly SearchField<AppManifest>[] = [
    { text: (app) => app.name, weight: 3 },
    { text: (app) => app.summary, weight: 2 },
    { text: (app) => app.keywords, weight: 1 },
    { text: (app) => app.category, weight: 1 }
];

export interface StoreFilter {
    readonly query: string;
    readonly category: StoreCategory;
    readonly sort: StoreSort;
    /** For the name sort: names compare the way the reader's language does. */
    readonly locale?: string;
}

/**
 * The apps the grid draws, in order. A search keeps its relevance order under
 * the featured sort, since that is the order somebody searching wants; any sort
 * still puts what can be installed before what is only announced, so the first
 * row of a store is never three things nobody can have.
 */
export function filterStoreApps(apps: readonly AppManifest[], filter: StoreFilter): AppManifest[] {
    const inCategory =
        filter.category === "all"
            ? [...apps]
            : apps.filter((app) => app.category === filter.category);
    const term = filter.query.trim();
    const matched = term ? searchItems(inCategory, term, APP_FIELDS) : inCategory;
    const order = new Map(apps.map((app, index) => [app.id, index]));
    const sorted = [...matched];
    if (filter.sort === "name") {
        const collator = new Intl.Collator(filter.locale, { sensitivity: "base" });
        sorted.sort((left, right) => collator.compare(left.name, right.name));
    } else if (filter.sort === "recent") {
        sorted.sort((left, right) => {
            const byDate = (ADDED_ON[right.id] ?? "").localeCompare(ADDED_ON[left.id] ?? "");
            return byDate !== 0 ? byDate : (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0);
        });
    }
    // Stable, so the order chosen above survives inside each half.
    return sorted.sort(
        (left, right) => Number(left.comingSoon ?? false) - Number(right.comingSoon ?? false)
    );
}

/** The categories that have at least one app, in the order the apps bring them. */
export function storeCategories(apps: readonly AppManifest[]): AppCategory[] {
    return [...new Set(apps.map((app) => app.category))];
}

export function storeShelf(app: AppManifest): StoreShelf {
    return appProvenance(app).firstParty ? "polaris" : "community";
}

/** The apps split by who is behind them, Polaris's first; an empty shelf is left out. */
export function storeShelves(
    apps: readonly AppManifest[]
): Array<{ shelf: StoreShelf; apps: AppManifest[] }> {
    return (["polaris", "community"] as const)
        .map((shelf) => ({ shelf, apps: apps.filter((app) => storeShelf(app) === shelf) }))
        .filter((group) => group.apps.length > 0);
}

/**
 * The hero row: apps that can be installed today and have a real capture to
 * show, in catalog order. A featured slot drawn around a placeholder would be
 * an advert for a picture that does not exist, so an app without one waits for
 * its capture instead.
 */
export function featuredApps(apps: readonly AppManifest[], limit = 3): AppManifest[] {
    return apps.filter((app) => isInstallable(app) && hasScreenshots(app.id)).slice(0, limit);
}

/** What the store needs to know about one install. */
export interface StoreInstall {
    readonly id: string;
    readonly status: string;
}

/**
 * The single action a card or an app's page leads with.
 *
 * - `open`: an app that runs once per Polaris and is here already.
 * - `installing`: this reader just pressed Install, or its one install is still
 *   coming up.
 * - `install`: offered; `configurable` when there is a server, storage or a
 *   setting to choose first (a builtin app runs nothing, so it has none).
 * - `locked`: installable, but not by this reader - the install action checks
 *   deploy.manage, and the button says why instead of failing on press.
 * - `comingSoon` / `unavailable`: announced, or declared without an image yet.
 */
export type PrimaryAction =
    | { readonly kind: "open"; readonly href: string }
    | { readonly kind: "deploy" }
    | { readonly kind: "installing" }
    | { readonly kind: "install"; readonly configurable: boolean }
    | { readonly kind: "locked" }
    | { readonly kind: "comingSoon" }
    | { readonly kind: "unavailable" };

export function primaryAction(
    app: AppManifest,
    state: { installs: readonly StoreInstall[]; canInstall: boolean; installing: boolean }
): PrimaryAction {
    if (state.installing) return { kind: "installing" };
    const first = state.installs[0];
    if (app.singleton && first) {
        if (first.status === "installing") return { kind: "installing" };
        return { kind: "open", href: app.opensAt ?? `/apps/installed/${first.id}` };
    }
    if (app.comingSoon) return { kind: "comingSoon" };
    if (!isInstallable(app)) return { kind: "unavailable" };
    if (!state.canInstall) return { kind: "locked" };
    // A template is a service in a project, not an install: Deploy's flow makes it.
    if (app.installMethod === "deploy-template") return { kind: "deploy" };
    return { kind: "install", configurable: app.installMethod !== "builtin" };
}

/**
 * The small badge beside the action: how the one install is doing, for an app
 * that runs something. A builtin app runs nothing, so it reads "installed"
 * rather than a "stopped" that could never be anything else.
 */
export function installBadge(
    app: AppManifest,
    installs: readonly StoreInstall[]
): { kind: "status"; status: string } | { kind: "installed" } | null {
    const first = installs[0];
    if (!first) return null;
    if (app.installMethod === "builtin") return { kind: "installed" };
    return { kind: "status", status: first.status };
}

/**
 * Which marketplace an app is listed in.
 *
 * `deployable` is /apps/marketplace: other developers' software that Polaris
 * deploys and runs for you. `polaris` is the admin screen (/admin/apps): the
 * apps that are part of Polaris itself and switch on for the whole instance.
 */
export type StoreScope = "deployable" | "polaris";

export function storeScope(app: AppManifest): StoreScope {
    return storeShelf(app) === "polaris" ? "polaris" : "deployable";
}

/** Everything the two marketplaces list: the catalog's offered apps, then Deploy's templates. */
export function storeApps(): AppManifest[] {
    return [...appsByCategory().flatMap((group) => group.apps), ...templateApps()];
}

/** A catalog app or a template entry, by its store id. */
export function findStoreApp(id: string): AppManifest | undefined {
    return findApp(id) ?? findTemplateApp(id);
}

/** The admin marketplace's address, opened on one app when one is named. */
export const POLARIS_APPS_PATH = "/admin/apps";

export function polarisAppsHref(appId?: string): string {
    return appId ? `${POLARIS_APPS_PATH}?app=${encodeURIComponent(appId)}` : POLARIS_APPS_PATH;
}

/** The user marketplace's address: other developers' apps. */
export const DEPLOYABLE_APPS_PATH = "/apps/marketplace";

/** The grid an app is listed in. */
export function storeHome(scope: StoreScope): string {
    return scope === "polaris" ? POLARIS_APPS_PATH : DEPLOYABLE_APPS_PATH;
}

/** An app's own page, in the marketplace that lists it. */
export function listingHref(app: AppManifest): string {
    return `${storeHome(storeScope(app))}/${encodeURIComponent(app.id)}`;
}

/** Entries of the switcher that are screens of the shell rather than apps anybody installs. */
const NOT_AN_APP = new Set(["overview", "admin", "account"]);

/**
 * The apps every Polaris comes with: in the switcher with no marketplace app
 * behind them (`requiresApp`), so nothing installs them and nothing removes
 * them yet. Listed on the admin screen the way a phone lists the apps it
 * shipped with.
 */
export function builtInApps(): AppEntry[] {
    return POLARIS_APPS.filter((app) => !app.requiresApp && !app.hidden && !NOT_AN_APP.has(app.id));
}

/**
 * The built-in app that already does a Deploy template's job, if one does.
 *
 * Read off what each built-in replaces (`APP_REPLACES`) rather than kept as a
 * second table: a built-in that lists a template's own product - the product's
 * tile is named after the template id, as Vaultwarden's is `vaultwarden` - does
 * that template's job, so the card can say so. A claim only has to be made once,
 * in the table the store page and the README already read.
 */
export function builtInAlternative(app: AppManifest): AppEntry | undefined {
    const product = app.deployTemplate;
    if (!product) return undefined;
    return builtInApps().find((entry) =>
        appReplaces(entry.id).some((item) => item.logo === product)
    );
}
