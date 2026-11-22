/**
 * Who probably holds the launcher's key when the system will not give it.
 *
 * The operating system does not say which program registered a key, so this
 * names the other launchers found on the computer: by an installed app's name
 * (the Start menu, /Applications, the .desktop entries the launcher indexes
 * anyway) and by one look at the running programs - taken at start and when
 * the settings open, never on a timer. A running launcher whose default is
 * the key asked for comes first.
 *
 * Defaults are the vendors' own: Raycast for Windows and PowerToys Run use
 * Alt+Space (https://manual.raycast.com/windows,
 * https://learn.microsoft.com/windows/powertoys/run), as do Flow Launcher
 * (https://github.com/Flow-Launcher/Flow.Launcher) and Alfred on macOS
 * (https://www.alfredapp.com/help/getting-started/). The others are named
 * without one: they are configurable and their defaults vary by version.
 */

export interface KnownLauncher {
    readonly name: string;
    /** The platforms it runs on. */
    readonly platforms: readonly NodeJS.Platform[];
    /** Its default key as an accelerator, when the vendor documents one. */
    readonly defaultAccelerator: string | null;
    /** Lowercase prefixes of its program's name in the process list. */
    readonly processes: readonly string[];
    /** Lowercase prefixes of its name as an installed app. */
    readonly apps: readonly string[];
}

export const KNOWN_LAUNCHERS: readonly KnownLauncher[] = [
    { name: "Raycast", platforms: ["win32", "darwin"], defaultAccelerator: "Alt+Space", processes: ["raycast"], apps: ["raycast"] },
    { name: "PowerToys Run", platforms: ["win32"], defaultAccelerator: "Alt+Space", processes: ["powertoys.powerlauncher"], apps: ["powertoys"] },
    { name: "Flow Launcher", platforms: ["win32"], defaultAccelerator: "Alt+Space", processes: ["flow.launcher"], apps: ["flow launcher"] },
    { name: "Listary", platforms: ["win32"], defaultAccelerator: null, processes: ["listary"], apps: ["listary"] },
    { name: "Wox", platforms: ["win32"], defaultAccelerator: null, processes: ["wox"], apps: ["wox"] },
    { name: "Alfred", platforms: ["darwin"], defaultAccelerator: "Alt+Space", processes: ["alfred"], apps: ["alfred"] },
    { name: "Ulauncher", platforms: ["linux"], defaultAccelerator: null, processes: ["ulauncher"], apps: ["ulauncher"] },
    { name: "Albert", platforms: ["linux"], defaultAccelerator: null, processes: ["albert"], apps: ["albert"] }
];

/** A launcher found on this computer, and whether it is running now. */
export interface FoundLauncher {
    readonly name: string;
    readonly running: boolean;
    readonly defaultAccelerator: string | null;
}

/** A program's name as it is compared: its file name, lowercase, without `.exe`. */
function bare(name: string): string {
    const file = name.replace(/\\/g, "/").split("/").pop() ?? name;
    return file.toLowerCase().replace(/\.(exe|app)$/, "");
}

/** The known launchers among the installed apps and running programs given. */
export function findLaunchers(
    platform: NodeJS.Platform,
    installedApps: readonly string[],
    runningPrograms: readonly string[]
): FoundLauncher[] {
    const apps = installedApps.map(bare);
    const running = runningPrograms.map(bare);
    const found: FoundLauncher[] = [];
    for (const launcher of KNOWN_LAUNCHERS) {
        if (!launcher.platforms.includes(platform)) continue;
        const isRunning = running.some((name) => launcher.processes.some((prefix) => name.startsWith(prefix)));
        const isInstalled = apps.some((name) => launcher.apps.some((prefix) => name.startsWith(prefix)));
        if (isRunning || isInstalled) found.push({ name: launcher.name, running: isRunning, defaultAccelerator: launcher.defaultAccelerator });
    }
    return found;
}

/**
 * The launchers most likely holding `accelerator`, most likely first: running
 * with it as their default, then running, then installed with it as default.
 * An installed launcher that is not running holds nothing and with another
 * default is not named.
 */
export function likelyHolders(accelerator: string, found: readonly FoundLauncher[]): string[] {
    const same = (launcher: FoundLauncher) => launcher.defaultAccelerator?.toLowerCase() === accelerator.toLowerCase();
    const rank = (launcher: FoundLauncher) => (launcher.running ? (same(launcher) ? 0 : 1) : same(launcher) ? 2 : 3);
    return found
        .filter((launcher) => rank(launcher) < 3)
        .sort((a, b) => rank(a) - rank(b))
        .map((launcher) => launcher.name);
}

/** The sentence the settings show when the key could not be taken. */
export function conflictSentence(key: string, holders: readonly string[]): string {
    if (holders.length === 0)
        return `${key} is in use by another program, possibly a browser extension. Record another shortcut, or free it there.`;
    const names = holders.length === 1 ? holders[0] : `${holders.slice(0, -1).join(", ")} or ${holders[holders.length - 1]}`;
    return `${key} is in use, most likely by ${names}. Change the shortcut there, or record another one here.`;
}
