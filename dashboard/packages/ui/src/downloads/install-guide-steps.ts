/**
 * What the install guide says and draws for each file Polaris hands out, and
 * which browser and system its pictures are drawn for.
 *
 * Pure, so the dashboard, the public site and their tests share one answer. The
 * words themselves are catalog keys: each screen translates them with its own
 * catalog, and this only decides which ones an item gets.
 */

/** A file that opens the guide once its download has started. */
export type GuideItem =
    "streamdeck" | "companion" | "extension-chromium" | "extension-firefox" | "desktop";

/** Every item, in the order the catalogs list them. */
export const GUIDE_ITEMS: readonly GuideItem[] = [
    "streamdeck",
    "companion",
    "extension-chromium",
    "extension-firefox",
    "desktop"
];

/** The three steps every guide has, in order. */
export type GuideStepId = "open" | "install" | "use";

/**
 * The picture a step is drawn with:
 * - `download` the browser's download list with the file in it,
 * - `progress` a window installing it,
 * - `dock` the system's taskbar or dock with the app on it,
 * - `toolbar` the browser's toolbar with the extension pinned.
 */
export type GuideArt = "download" | "progress" | "dock" | "toolbar";

export interface GuideStep {
    readonly id: GuideStepId;
    readonly art: GuideArt;
    /** The catalog key of the step's one-word title. */
    readonly titleKey: string;
    /** The catalog key of the step's one sentence; it may use `{file}` and `{app}`. */
    readonly bodyKey: string;
}

/** Where the guide's words live, under the `account` namespace. */
export const GUIDE_KEY_ROOT = "downloads.guide";

const STEP_IDS: readonly GuideStepId[] = ["open", "install", "use"];

/** The extensions are used from the browser, everything else from the system. */
function artFor(item: GuideItem, step: GuideStepId): GuideArt {
    if (step === "open") return "download";
    if (step === "install") return "progress";
    return item.startsWith("extension-") ? "toolbar" : "dock";
}

/** The three steps of one item's guide. */
export function guideSteps(item: GuideItem): readonly GuideStep[] {
    return STEP_IDS.map((id) => ({
        id,
        art: artFor(item, id),
        titleKey: `${GUIDE_KEY_ROOT}.steps.${id}`,
        bodyKey: `${GUIDE_KEY_ROOT}.items.${item}.${id}`
    }));
}

/** Whose download list the first picture shows. */
export type GuideBrowser = "chromium" | "firefox" | "safari" | "neutral";

/** Whose taskbar or dock the last picture shows. */
export type GuideOs = "windows" | "macos" | "linux" | "neutral";

/** The part of `navigator.userAgentData` the guide reads, where a browser has it. */
export interface GuideClientHints {
    readonly brands?: readonly { readonly brand: string }[];
    readonly platform?: string;
}

/**
 * The browser whose download list to draw. Client hints first, because Brave
 * and Edge both answer as Chrome in some user agents; then the user agent. A
 * browser neither names is drawn as a neutral one rather than guessed.
 */
export function detectGuideBrowser(userAgent: string, hints?: GuideClientHints): GuideBrowser {
    const brands = (hints?.brands ?? []).map((entry) => entry.brand.toLowerCase());
    if (brands.some((brand) => /chrom|edge|brave|opera/.test(brand))) return "chromium";
    if (/firefox|fxios/i.test(userAgent)) return "firefox";
    if (/chrome|chromium|crios|edg\//i.test(userAgent)) return "chromium";
    if (/safari/i.test(userAgent) && /version\//i.test(userAgent)) return "safari";
    return "neutral";
}

/**
 * The system whose taskbar or dock to draw. A phone or tablet is neutral: the
 * files here are for a computer, and a dock it does not have would mislead.
 */
export function detectGuideOs(userAgent: string, hints?: GuideClientHints): GuideOs {
    const platform = hints?.platform?.toLowerCase() ?? "";
    if (platform === "windows") return "windows";
    if (platform === "macos") return "macos";
    if (platform === "linux" || platform === "chrome os") return "linux";
    if (/android|iphone|ipad|ipod/i.test(userAgent)) return "neutral";
    if (/windows|win32|win64/i.test(userAgent)) return "windows";
    if (/macintosh|mac os x/i.test(userAgent)) return "macos";
    if (/linux|x11|cros/i.test(userAgent)) return "linux";
    return "neutral";
}

/** The guide's environment, read from this browser; neutral where there is none. */
export function detectGuideEnv(): { browser: GuideBrowser; os: GuideOs } {
    if (typeof navigator === "undefined") return { browser: "neutral", os: "neutral" };
    const hints = (navigator as Navigator & { userAgentData?: GuideClientHints }).userAgentData;
    return {
        browser: detectGuideBrowser(navigator.userAgent, hints),
        os: detectGuideOs(navigator.userAgent, hints)
    };
}
