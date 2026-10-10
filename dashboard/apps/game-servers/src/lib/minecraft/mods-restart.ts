/**
 * Whether a change to a server's mods is still waiting for a restart.
 *
 * A mod goes onto a server's list in a moment and onto the server only when it
 * starts, since the image installs the list at boot. Some changes restart the
 * server there and then (the Mods tab's own save); others leave it running and
 * say "on the next start" (Symbiote, a settings save that was not applied). For
 * those the panel draws the same restart card an update to Polaris login draws,
 * so the restart can be had now, when the server empties, or at a time - and
 * the card goes once the server has started again since the change.
 *
 * The moment of the last such change is kept on the install, so the card is
 * there after a reload and for a second operator too.
 *
 * Pure.
 */

/** Where an install keeps when its mods last changed without a restart. */
export const MODS_CHANGED_KEY = "modsChangedAt";

/** The variables that are a server's mod and plugin lists: the image installs
 *  what they name when it boots. */
const MOD_LIST_KEYS: ReadonlySet<string> = new Set([
    "MODRINTH_PROJECTS",
    "MODRINTH_DOWNLOAD_DEPENDENCIES",
    "MODRINTH_MODPACK",
    "SPIGET_RESOURCES",
    "MODS"
]);

/** Whether writing this variable changes what the server installs at boot. */
export function isModListKey(key: string): boolean {
    return MOD_LIST_KEYS.has(key);
}

/** The moment kept on an install's settings blob, or null. */
export function modsChangedAt(config: Readonly<Record<string, unknown>>): Date | null {
    const raw = config[MODS_CHANGED_KEY];
    if (typeof raw !== "string") return null;
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Whether the server is up on a run that began before the last change: the
 * change is on the list and not yet on the server. A server that is not up has
 * nothing waiting - its next start installs the list as it stands.
 */
export function modsAwaitRestart(changedAt: Date | null, upSince: Date | null): boolean {
    return changedAt !== null && upSince !== null && changedAt > upSince;
}
