/**
 * What the app can install on this computer with one press, and exactly how.
 *
 * The page only ever names a tool from this list. The script's address and the
 * way it is started are decided here, so a page cannot make the app run anything
 * else. They are the same official scripts the downloads screen shows as a line
 * to paste. Pure, so every line can be asserted without Electron.
 */

import { z } from "zod";

export const INSTALL_TOOLS = ["extension", "cli", "deck"] as const;
export type InstallTool = (typeof INSTALL_TOOLS)[number];

/** The browsers an unpacked extension can be loaded into. */
export const EXTENSION_BROWSERS = ["chrome", "edge", "brave", "opera"] as const;
export type ExtensionBrowser = (typeof EXTENSION_BROWSERS)[number];

export const installRequestSchema = z.object({
    tool: z.enum(INSTALL_TOOLS),
    browser: z.enum(EXTENSION_BROWSERS).optional()
});
export type InstallRequest = z.infer<typeof installRequestSchema>;

/** Answered to the page. `folder` is what to choose in Load unpacked. */
export type InstallResult = { readonly ok: true; readonly folder?: string; } | { readonly ok: false; readonly error: string; };

const SCRIPTS: Readonly<Record<InstallTool, string>> = {
    extension: "dashboard/apps/extension/scripts",
    cli: "dashboard/packages/cli/scripts",
    deck: "dashboard/apps/streamdeck/scripts"
};

const NAMES: Readonly<Record<InstallTool, string>> = {
    extension: "the Polaris browser extension",
    cli: "the Polaris command-line client",
    deck: "the Polaris Stream Deck plugin"
};

/** The sentence the confirmation asks. */
export function installQuestion(tool: InstallTool): string {
    return `Install ${NAMES[tool]} on this computer?`;
}

/** Whether a tool can be installed on a system. The deck's app has no Linux build. */
export function installable(tool: InstallTool, platform: string): boolean {
    if (tool === "deck") return platform === "win32" || platform === "darwin";
    return platform === "win32" || platform === "darwin" || platform === "linux";
}

export interface Launch {
    readonly file: string;
    readonly args: readonly string[];
}

/** The owner/name of a GitHub repository address, or null when it is not one. */
export function repositorySlug(repository: string): string | null {
    return /^(?:git\+)?https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repository)?.[1] ?? null;
}

/** How to run a tool's installer: the program and its arguments, with no shell
 *  in between on Windows and a fixed line on the others. */
export function installLaunch(tool: InstallTool, platform: string, repo: string): Launch {
    const scripts = `https://raw.githubusercontent.com/${repo}/main/${SCRIPTS[tool]}`;
    if (platform === "win32") {
        return {
            file: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command", `irm '${scripts}/install.ps1' | iex`]
        };
    }
    return { file: "/bin/sh", args: ["-c", `curl -fsSL '${scripts}/install.sh' | sh`] };
}

export interface Folders {
    readonly home: string;
    /** %LOCALAPPDATA% on Windows. */
    readonly localAppData?: string;
    /** %APPDATA% on Windows. */
    readonly appData?: string;
    readonly xdgData?: string;
}

/**
 * What the script leaves behind when it worked. A script that refuses, because
 * Node is missing for example, says so and ends normally, so its exit code does
 * not tell the two apart.
 */
export function installedPath(tool: InstallTool, platform: string, folders: Folders): string {
    const windows = platform === "win32";
    const join = (...parts: string[]) => parts.join(windows ? "\\" : "/");
    const macData = join(folders.home, "Library", "Application Support");
    const xdg = folders.xdgData ?? join(folders.home, ".local", "share");
    if (tool === "extension") {
        if (windows) return join(folders.localAppData ?? "", "Polaris", "extension", "chrome");
        if (platform === "darwin") return join(macData, "Polaris", "extension", "chrome");
        return join(xdg, "polaris", "extension", "chrome");
    }
    if (tool === "cli") {
        if (windows) return join(folders.localAppData ?? "", "Programs", "polaris-cli");
        return join(xdg, "polaris-cli");
    }
    const plugin = "io.github.fjrg2007.polaris.sdPlugin";
    if (windows) return join(folders.appData ?? "", "Elgato", "StreamDeck", "Plugins", plugin);
    return join(macData, "com.elgato.StreamDeck", "Plugins", plugin);
}

/** The last thing the script said, without its prefix, for a refusal. */
export function lastSaid(output: string): string | null {
    const line = output
        .split(/\r?\n/)
        .map((entry) => entry.replace(/^polaris:\s*/, "").trim())
        .filter((entry) => /[a-z]/i.test(entry))
        .at(-1);
    return line ? line.slice(0, 300) : null;
}

/** A browser by the name the system gives the default one, or null for one no
 *  extension of ours loads into. */
export function browserFromName(name: string): ExtensionBrowser | null {
    const lower = name.toLowerCase();
    if (lower.includes("brave")) return "brave";
    if (lower.includes("edge")) return "edge";
    if (lower.includes("opera")) return "opera";
    if (lower.includes("chrome")) return "chrome";
    return null;
}

const PROGRAMS: Readonly<Record<ExtensionBrowser, { windows: string; mac: string; linux: string; }>> = {
    chrome: { windows: "chrome", mac: "Google Chrome", linux: "google-chrome" },
    edge: { windows: "msedge", mac: "Microsoft Edge", linux: "microsoft-edge" },
    brave: { windows: "brave", mac: "Brave Browser", linux: "brave-browser" },
    opera: { windows: "opera", mac: "Opera", linux: "opera" }
};

/** How to open a browser on its extensions page, the one step a script cannot
 *  take for it: browsers only install on their own from their store. */
export function extensionsPageLaunch(browser: ExtensionBrowser, platform: string): Launch {
    const page = `${browser}://extensions`;
    const program = PROGRAMS[browser];
    if (platform === "win32") {
        return {
            file: "powershell.exe",
            args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${program.windows}' '${page}'`]
        };
    }
    if (platform === "darwin") return { file: "/usr/bin/open", args: ["-a", program.mac, page] };
    return { file: program.linux, args: [page] };
}
