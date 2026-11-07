/**
 * Which way a TV gets Polaris TV, decided from what was found on the network and
 * what the TV says about itself, never asked of the person. Every per-brand
 * difference comes from the "Does it work on my TV?" data in core
 * (`dashboard/packages/core/src/tv-compat`), so a model added there changes the
 * install without a line changing here.
 */

import models from "@tv-compat/models.json";
import debugging from "@tv-compat/debugging.json";
import { compactModel } from "@tv-compat/search";
import type { TvDebugging, TvDebuggingSteps, TvModel, TvPlatform, TvQuirkId } from "@tv-compat/schema";

const PACKAGE = "app.polaris.tv";
/** Android 8.0, the launcher's minSdk (`MIN_ANDROID` in the checker's rules). */
const MIN_SDK = 26;
const TV_MODELS = models as readonly TvModel[];
const TV_DEBUGGING = debugging as TvDebugging;

/** The services a TV announces over mDNS, by their service type without `._tcp`. */
export type TvService = "adb" | "adb-tls-connect" | "adb-tls-pairing" | "googlecast";

/** What discovery found at one address: a typed address or a port sweep hit has no services. */
export interface TvSighting {
    readonly services: readonly TvService[];
    /** The model a Cast record named (its `md` field), when one answered. */
    readonly castModel?: string | null;
    /** Whether the classic network debugging port answered. */
    readonly adbOpen?: boolean;
}

/** What the TV says about itself once connected. */
export interface TvIdentity {
    readonly manufacturer: string;
    readonly model: string;
    /** The Android API level, null when it did not say. */
    readonly sdk: number | null;
}

/**
 * network: the debugging port, now or once it is turned on. pairing: the TV only
 * opens debugging through Wireless debugging pairing. network-only: no app on
 * this TV, ad blocking through the Network filter.
 */
export type TvRoute = "network" | "pairing" | "network-only";

/** offered: the Home switch is the person's. app-only: the maker keeps Home.
 *  refused-by-maker: switching Home has left this maker's sets unable to start. */
export type TvHomeRule = "offered" | "app-only" | "refused-by-maker";

export interface TvPath {
    readonly route: TvRoute;
    readonly home: TvHomeRule;
    /** The listed model this TV was matched to. */
    readonly model: TvModel | null;
    readonly platform: TvPlatform | null;
    /** Why the path differs from a plain Android TV, as a quirk of the checker data. */
    readonly reason: TvQuirkId | null;
    /** Run by the installer after the install; never shown. */
    readonly afterInstall: readonly string[];
    /** Where the person turns debugging on, for this TV's platform. */
    readonly instruction: TvDebuggingSteps;
}

/** TCL firmware keeps an app from starting itself without these app-ops
 *  (`tv/addons/game-day/setup.sh`, `tv/addons/brightness/install.sh`). */
export const TCL_APPOPS: readonly string[] = [
    `appops set ${PACKAGE} AUTO_START allow`,
    `cmd appops set ${PACKAGE} APP_AUTO_START allow`
];

/** A brand's first word, lowercase: "Amazon Fire TV" is "amazon". */
function makerOf(brand: string): string {
    return brand.trim().toLowerCase().split(/\s+/)[0] ?? "";
}

/** Makers whose Home switch is refused: Huawei by the quirk's own name, and every
 *  brand the data lists with that quirk. */
const REFUSED_MAKERS = new Set([
    "huawei",
    ...TV_MODELS.filter((model) => model.quirks.includes("huawei-refusal")).map((model) => makerOf(model.brand))
]);

const TCL_MAKERS = new Set(
    TV_MODELS.filter((model) => model.quirks.includes("tcl-autostart")).map((model) => makerOf(model.brand))
);

/** The platform every listed model of a maker shares, or null when they differ. */
function makerPlatform(maker: string): TvPlatform | null {
    const platforms = new Set(TV_MODELS.filter((model) => makerOf(model.brand) === maker).map((model) => model.platform));
    return platforms.size === 1 ? ([...platforms][0] ?? null) : null;
}

function stepsFor(platform: TvPlatform | null): TvDebuggingSteps {
    const own = platform ? TV_DEBUGGING.platforms.find((entry) => entry.platforms.includes(platform)) : undefined;
    return own ?? (TV_DEBUGGING.platforms[0] as TvDebuggingSteps);
}

/** The listed model a name means, only when its model text or an alias holds it whole. */
export function matchModel(name: string | null | undefined, maker?: string | null): TvModel | null {
    const typed = compactModel(name ?? "");
    if (typed.length < 3) return null;
    const holds = (model: TvModel) =>
        [model.model, ...model.aliases].some((text) => compactModel(text).includes(typed)) &&
        (!maker || makerOf(model.brand) === maker.toLowerCase());
    // The most specific entry wins: "55C71K" is the 55" set, not a listing that names a whole range.
    const size = (model: TvModel) => compactModel(model.model).length;
    return TV_MODELS.filter(holds).sort((left, right) => size(left) - size(right))[0] ?? null;
}

/** The way this TV gets Polaris TV. `identity` refines it once the TV answered. */
export function choosePath(sighting: TvSighting, identity?: TvIdentity | null): TvPath {
    const maker = identity ? makerOf(identity.manufacturer) : null;
    const model = matchModel(identity?.model, maker) ?? matchModel(sighting.castModel);
    const platform = model?.platform ?? (maker ? makerPlatform(maker) : null);
    const quirks = new Set<TvQuirkId>(model?.quirks ?? []);
    const makerOfTv = maker ?? (model ? makerOf(model.brand) : null);
    const instruction = stepsFor(platform);
    const base = { model, platform, instruction };

    const tooOld = identity?.sdk !== null && identity?.sdk !== undefined && identity.sdk < MIN_SDK;
    if (tooOld || model?.install === "none")
        return {
            ...base,
            route: "network-only",
            home: "app-only",
            reason: tooOld ? "android-too-old" : (model?.quirks[0] ?? "android-check"),
            afterInstall: []
        };

    const adbOpen = sighting.adbOpen === true || sighting.services.includes("adb");
    const tlsOnly = sighting.services.some((service) => service === "adb-tls-connect" || service === "adb-tls-pairing");
    const pairing = !adbOpen && !identity && (tlsOnly || model?.install === "desktop-pairing");

    const refused = quirks.has("huawei-refusal") || (makerOfTv !== null && REFUSED_MAKERS.has(makerOfTv));
    const fire = platform === "fire-os" || quirks.has("fire-home-amazon");
    // A TCL on Fire OS runs Amazon's firmware, not TCL's, so it has no such app-op.
    const tcl = quirks.has("tcl-autostart") || (!fire && makerOfTv !== null && TCL_MAKERS.has(makerOfTv));
    const home: TvHomeRule = refused ? "refused-by-maker" : fire ? "app-only" : "offered";
    const reason: TvQuirkId | null = pairing
        ? "google-pairing"
        : refused
          ? "huawei-refusal"
          : fire
            ? "fire-home-amazon"
            : tcl
              ? "tcl-autostart"
              : null;
    return { ...base, route: pairing ? "pairing" : "network", home, reason, afterInstall: tcl ? TCL_APPOPS : [] };
}
