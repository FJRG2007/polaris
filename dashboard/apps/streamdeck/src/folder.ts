/**
 * The Polaris folder: one key with the Polaris mark that opens a page of
 * Polaris keys, and the same key on that page that takes you back.
 *
 * A plugin cannot add a folder to someone's own profile or change a folder's
 * icon, and it can only switch to profiles it ships itself
 * (docs.elgato.com/streamdeck/sdk/guides/profiles). So the "folder" is a
 * profile bundled with the plugin, one per kind of deck
 * (`scripts/profiles.mjs` builds them), opened with `switchToProfile`; the
 * key on it switches back to the previous profile.
 *
 * SDK-free, so the tests reach it.
 */

/** The bundled profile for each kind of deck, by the SDK's `DeviceType`
 *  number, as named in the manifest's `Profiles`. */
export const FOLDER_PROFILES: Readonly<Record<number, string>> = {
    0: "profiles/polaris",
    1: "profiles/polaris-mini",
    2: "profiles/polaris-xl",
    7: "profiles/polaris-plus",
    9: "profiles/polaris-neo",
    13: "profiles/polaris-plus-xl"
};

/** What the folder key keeps in its settings. Only the one on the bundled
 *  page carries `back`. */
export type FolderSettings = { back?: boolean };

/** Where a press of the folder key goes: back to the profile before, the
 *  bundled profile for this deck, or nowhere when there is none for it. */
export function folderTarget(
    settings: FolderSettings,
    deviceType: number
): { to: "back" } | { to: "profile"; profile: string } | { to: "none" } {
    if (settings.back === true) return { to: "back" };
    const profile = FOLDER_PROFILES[deviceType];
    return profile ? { to: "profile", profile } : { to: "none" };
}
