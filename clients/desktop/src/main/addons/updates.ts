/**
 * Keeping installed add-ons up to date: what to do about a newer version in the
 * signed catalog, when to look again, and what to say about it. Pure, for the
 * tests; the manager (`manager.ts`) acts on the answers.
 *
 * Updates go in by themselves unless the person turned that off, the way the
 * app updates itself (`../updates.ts`), with three exceptions: a version that
 * asks for a permission the person has not accepted waits for them, an add-on
 * that says its device is busy is not swapped under them, and a version that
 * already failed here and was rolled back from is left for them to choose.
 */

import { addonFit, compareAddonVersions, type AddonEntry, type AddonPermission, type AddonPlatform } from "@polaris/core/device-addons";

/** The first look after the app starts, so starting is not slowed by it. */
export const FIRST_CHECK_MS = 60_000;
/** How often the catalog is looked at while the app runs. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** The first wait after a failed look (offline, GitHub not answering); doubled each time, up to `CHECK_EVERY_MS`. */
export const RETRY_FIRST_MS = 5 * 60_000;

/** How long to wait before the next look, after `failures` failed ones in a row. */
export function nextCheckDelay(failures: number): number {
    if (failures <= 0) return CHECK_EVERY_MS;
    return Math.min(RETRY_FIRST_MS * 2 ** Math.min(failures - 1, 16), CHECK_EVERY_MS);
}

/** The permissions a version asks for that the person has not accepted. */
export function addedPermissions(asked: readonly AddonPermission[], granted: readonly AddonPermission[]): AddonPermission[] {
    return asked.filter((permission) => !granted.includes(permission));
}

export interface UpdateFacts {
    readonly installed: {
        readonly version: string;
        readonly granted: readonly AddonPermission[];
        readonly autoUpdate?: boolean;
        readonly failed?: string;
    };
    /** The catalog's entry for it, if the catalog still lists it. */
    readonly entry: AddonEntry | null | undefined;
    readonly platform: AddonPlatform | null;
    readonly appVersion: string;
    /** The setting for every add-on: absent in an `installed.json` from before it, which means on. */
    readonly autoUpdate: boolean | undefined;
    /** It says its device is in use right now. */
    readonly busy: boolean;
}

export type UpdateDecision =
    /** Nothing newer this app can install. */
    | { readonly kind: "none"; }
    /** Put it in now, in the background. */
    | { readonly kind: "apply"; readonly version: string; }
    /** Newer, and left for the person: automatic updates are off for it, or this version failed here before. */
    | { readonly kind: "offer"; readonly version: string; readonly why: "manual" | "failed"; }
    /** Newer, but it asks for permissions the person has to accept first. */
    | { readonly kind: "consent"; readonly version: string; readonly added: readonly AddonPermission[]; }
    /** Newer and going in by itself, once the add-on is no longer busy. */
    | { readonly kind: "wait"; readonly version: string; };

/** Whether automatic updates apply to one add-on: its own choice, else the setting for all, else on. */
export function autoUpdates(own: boolean | undefined, all: boolean | undefined): boolean {
    return own ?? all ?? true;
}

export function decideUpdate(facts: UpdateFacts): UpdateDecision {
    const { entry, installed } = facts;
    if (!entry || compareAddonVersions(entry.version, installed.version) <= 0) return { kind: "none" };
    if (!addonFit(entry, facts.platform, facts.appVersion).ok) return { kind: "none" };
    const added = addedPermissions(entry.permissions, installed.granted);
    if (added.length > 0) return { kind: "consent", version: entry.version, added };
    if (!autoUpdates(installed.autoUpdate, facts.autoUpdate)) return { kind: "offer", version: entry.version, why: "manual" };
    if (installed.failed === entry.version) return { kind: "offer", version: entry.version, why: "failed" };
    return facts.busy ? { kind: "wait", version: entry.version } : { kind: "apply", version: entry.version };
}

/** What the person is told about one version, once. */
export type UpdateNews =
    | { readonly kind: "updated"; readonly name: string; readonly version: string; readonly changelog: string; }
    | { readonly kind: "available"; readonly name: string; readonly version: string; readonly changelog: string; }
    | { readonly kind: "consent"; readonly name: string; readonly version: string; readonly added: readonly AddonPermission[]; }
    | { readonly kind: "rolled-back"; readonly name: string; readonly from: string; readonly to: string; };

/** Whether this version was already announced. */
export function announced(notified: string | undefined, version: string): boolean {
    return notified === version;
}

const PERMISSION_WORDS: Record<AddonPermission, string> = {
    usb: "use USB devices",
    "audio-sessions": "see and change app volumes",
    display: "draw on a device's screen",
    "polaris-actions": "use Polaris actions such as mute",
    network: "reach the network"
};

/** The first line of a changelog, short enough for a notice. */
function firstLine(changelog: string): string {
    const line = changelog.split("\n").map((part) => part.replace(/^[-*\s]+/, "").trim()).find((part) => part.length > 0) ?? "";
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** The words of a notice for it. The desktop app's own text is English (as its other notices are). */
export function newsWords(news: UpdateNews): { readonly title: string; readonly body: string; } {
    switch (news.kind) {
        case "updated":
            return { title: `${news.name} updated to ${news.version}`, body: firstLine(news.changelog) || "See what changed in its settings." };
        case "available":
            return { title: `${news.name} ${news.version} is available`, body: firstLine(news.changelog) || "Open its settings to update it." };
        case "consent":
            return {
                title: `${news.name} ${news.version} needs your OK`,
                body: `It asks to ${news.added.map((permission) => PERMISSION_WORDS[permission]).join(", ")}. It is not updated until you accept.`
            };
        case "rolled-back":
            return { title: `${news.name} ${news.from} did not start`, body: `Version ${news.to} was put back, so it keeps working.` };
    }
}
