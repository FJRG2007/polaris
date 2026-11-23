/**
 * The launcher's command registry: each command once, with the surfaces it
 * runs on, so every surface lists the same ones and hides what it cannot do
 * rather than offering it and refusing. What a command does is each surface's
 * own (Polaris Desktop's `shared/system-commands` for the system ones); this
 * is only what they agree on: the id, the words it is found by, and whether it
 * asks before it runs.
 */

/** Where a command can run. */
export type LauncherSurface = "desktop" | "web" | "extension" | "mobile" | "tv";

export const SYSTEM_COMMAND_IDS = ["lock", "sleep", "restart", "shutdown", "logout", "empty-trash"] as const;

export type SystemCommandId = (typeof SYSTEM_COMMAND_IDS)[number];

export interface LauncherCommand {
    readonly id: SystemCommandId;
    readonly surfaces: readonly LauncherSurface[];
    /** The English name, for a surface with no translations (the desktop's own panel). */
    readonly label: string;
    /** More words it is found by, besides its name. */
    readonly words: readonly string[];
    /** Irreversible or loses unsaved work: asks before it runs. */
    readonly confirm: boolean;
}

export const LAUNCHER_COMMANDS: readonly LauncherCommand[] = [
    { id: "lock", surfaces: ["desktop"], label: "Lock screen", words: ["lock", "away"], confirm: false },
    { id: "sleep", surfaces: ["desktop"], label: "Sleep", words: ["sleep", "suspend"], confirm: false },
    { id: "restart", surfaces: ["desktop"], label: "Restart", words: ["restart", "reboot"], confirm: true },
    { id: "shutdown", surfaces: ["desktop"], label: "Shut down", words: ["shut down", "shutdown", "power off", "turn off"], confirm: true },
    { id: "logout", surfaces: ["desktop"], label: "Log out", words: ["log out", "logout", "sign out", "log off"], confirm: true },
    { id: "empty-trash", surfaces: ["desktop"], label: "Empty bin", words: ["empty trash", "empty bin", "recycle bin", "trash"], confirm: true }
];

/** The commands `surface` lists. */
export function launcherCommandsFor(surface: LauncherSurface): LauncherCommand[] {
    return LAUNCHER_COMMANDS.filter((command) => command.surfaces.includes(surface));
}

export function isSystemCommandId(value: unknown): value is SystemCommandId {
    return typeof value === "string" && (SYSTEM_COMMAND_IDS as readonly string[]).includes(value);
}
