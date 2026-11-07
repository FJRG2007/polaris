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

/**
 * Answered to the page, which words the reason in its reader's language. `said`
 * is the script's own sentence for a refusal.
 */
export type InstallFailure = "cancelled" | "unsupported" | "busy" | "refused" | "failed";
/** How an extension install ended up in the browser: registered from its store, or
 *  fetched to a folder for Load unpacked. */
export type InstallVia = "store-entry" | "unpacked";
export type InstallResult = { readonly ok: true; readonly via?: InstallVia; } | { readonly ok: false; readonly reason: InstallFailure; readonly said?: string; };

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

const PATH_MARK = "__POLARIS_PATH__";
const USUAL_PATHS = ["/usr/local/bin", "/opt/homebrew/bin"];

/** Prints the PATH of a shell, marked off from whatever its startup files print. */
export const PATH_PROBE = `printf '${PATH_MARK}%s${PATH_MARK}' "$PATH"`;

/**
 * The PATH a script needs on macOS and Linux. An app opened from the desktop does
 * not get the one a terminal has, so Node would look missing where it is there.
 */
export function installPath(probed: string, inherited: string | undefined): string {
    const said = new RegExp(`${PATH_MARK}(.*?)${PATH_MARK}`).exec(probed)?.[1];
    const entries = [said, inherited, ...USUAL_PATHS].flatMap((entry) => entry?.split(":") ?? []);
    return [...new Set(entries.filter(Boolean))].join(":");
}

export interface Folders {
    readonly home: string;
    /** %LOCALAPPDATA% on Windows. */
    readonly localAppData?: string;
    /** %APPDATA% on Windows. */
    readonly appData?: string;
    readonly xdgData?: string;
}

/** What the script leaves behind when it worked. */
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
        if (windows) return join(folders.localAppData ?? "", "Programs", "polaris-cli", "polaris.mjs");
        return join(xdg, "polaris-cli", "polaris.mjs");
    }
    const plugin = "io.github.fjrg2007.polaris.sdPlugin";
    if (windows) return join(folders.appData ?? "", "Elgato", "StreamDeck", "Plugins", plugin);
    return join(macData, "com.elgato.StreamDeck", "Plugins", plugin);
}

/** What each script prints only once it has reached its end. */
const FINISHED: Readonly<Record<InstallTool, string>> = {
    extension: "First time: open chrome://extensions",
    cli: "installed plr",
    deck: "Next: open the Stream Deck app"
};

/**
 * Whether the script ran to its end. On Windows every refusal and failed download
 * ends normally, and a piped script hides a failed fetch everywhere, so neither
 * the exit code nor a file an earlier install left can tell.
 */
export function scriptFinished(tool: InstallTool, output: string): boolean {
    return output.includes(FINISHED[tool]);
}

const CLI_PROBLEM = /^!\s*polaris-cli:\s*/;
const SCRIPT_LINE = /^polaris:\s*/;

/** The script's own last sentence, without its prefix or this account's folder,
 *  or null when it said nothing of its own. A CLI refusal can span several lines. */
export function lastSaid(output: string, home: string): string | null {
    const lines = output.split(/\r?\n/).map((entry) => entry.trim());
    const problems = lines.map((entry) => CLI_PROBLEM.test(entry));
    const end = problems.lastIndexOf(true);
    let said: string | undefined;
    if (end >= 0) {
        let start = end;
        while (start > 0 && problems[start - 1]) start--;
        said = lines.slice(start, end + 1).map((entry) => entry.replace(CLI_PROBLEM, "")).join(" ");
    } else {
        said = lines
            .filter((entry) => SCRIPT_LINE.test(entry))
            .map((entry) => entry.replace(SCRIPT_LINE, ""))
            .filter((entry) => /[a-z]/i.test(entry))
            .at(-1);
    }
    if (!said) return null;
    return (home ? said.replaceAll(home, "~") : said).slice(0, 300);
}

/** The answer for a script that did not leave the tool installed. */
export function installFailure(tool: InstallTool, output: string, home: string): InstallResult {
    const said = scriptFinished(tool, output) ? null : lastSaid(output, home);
    return said ? { ok: false, reason: "failed", said } : { ok: false, reason: "failed" };
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

/**
 * Where the extension is listed. Empty until it is published: a browser handed an
 * id that is not in its store installs nothing, so nothing here is guessed. The
 * same ids as the page's `EXTENSION_LISTINGS` (dashboard/packages/ui).
 */
export interface StoreListings {
    readonly chromeWebStore: string | null;
    readonly edgeAddons: string | null;
}

export const STORE_LISTINGS: StoreListings = { chromeWebStore: null, edgeAddons: null };

/** The update addresses the stores serve their items from. */
export const CHROME_WEB_STORE_UPDATE = "https://clients2.google.com/service/update2/crx";
export const EDGE_ADDONS_UPDATE = "https://edge.microsoft.com/extensionwebstorebase/v1/crx";

const EXTENSION_ID = /^[a-p]{32}$/;

/**
 * A browser's "external extension" entry for the store listing: the documented way
 * other software on a computer asks a browser to install an extension from its
 * store. The browser asks the user to enable it the next time it opens, on
 * Windows and macOS; nothing installs silently.
 *
 * Only the places that are both per-user (no administrator rights) and documented
 * by the browser or read by its source: Chrome reads `HKCU` on Windows
 * (external_registry_loader_win.cc) and a per-user folder on macOS; Edge documents
 * per-user folders on macOS and Linux. Edge's Windows key, Brave and Opera have no
 * documented per-user entry, so they get null and the unpacked way instead.
 */
export type ExternalEntry =
    | { readonly kind: "registry"; readonly key: string; readonly updateUrl: string; }
    | { readonly kind: "file"; readonly path: string; readonly contents: string; };

export function externalEntry(
    browser: ExtensionBrowser,
    platform: string,
    folders: Folders,
    listings: StoreListings = STORE_LISTINGS
): ExternalEntry | null {
    const chrome = listings.chromeWebStore;
    const edge = listings.edgeAddons;
    const file = (path: string, updateUrl: string): ExternalEntry => ({
        kind: "file",
        path,
        contents: `${JSON.stringify({ external_update_url: updateUrl }, null, 4)}\n`
    });
    if (browser === "chrome" && chrome && EXTENSION_ID.test(chrome)) {
        if (platform === "win32") {
            return { kind: "registry", key: `HKCU\\Software\\Google\\Chrome\\Extensions\\${chrome}`, updateUrl: CHROME_WEB_STORE_UPDATE };
        }
        if (platform === "darwin") {
            const dir = [folders.home, "Library", "Application Support", "Google", "Chrome", "External Extensions"].join("/");
            return file(`${dir}/${chrome}.json`, CHROME_WEB_STORE_UPDATE);
        }
        return null;
    }
    if (browser === "edge" && platform !== "win32") {
        // Edge installs Chrome Web Store items too, from that store's address.
        const id = edge && EXTENSION_ID.test(edge) ? edge : chrome && EXTENSION_ID.test(chrome) ? chrome : null;
        if (!id) return null;
        const updateUrl = id === edge ? EDGE_ADDONS_UPDATE : CHROME_WEB_STORE_UPDATE;
        const dir = platform === "darwin"
            ? [folders.home, "Library", "Application Support", "Microsoft Edge", "External Extensions"].join("/")
            : [folders.home, ".config", "microsoft-edge", "External Extensions"].join("/");
        return file(`${dir}/${id}.json`, updateUrl);
    }
    return null;
}

/** Writes a registry entry, replacing the same one: running it twice is running it once. */
export function registryAddLaunch(entry: Extract<ExternalEntry, { kind: "registry"; }>): Launch {
    return { file: "reg.exe", args: ["add", entry.key, "/v", "update_url", "/t", "REG_SZ", "/d", entry.updateUrl, "/f"] };
}

/** Removes a registry entry this app wrote. */
export function registryDeleteLaunch(key: string): Launch {
    return { file: "reg.exe", args: ["delete", key, "/f"] };
}

/** The entries the app may have written on Windows, for its uninstaller to take back. */
export function windowsEntryKeys(listings: StoreListings = STORE_LISTINGS): string[] {
    const entry = externalEntry("chrome", "win32", { home: "" }, listings);
    return entry?.kind === "registry" ? [entry.key] : [];
}

/** How to open a browser as it is, for the confirmation it shows on opening. */
export function browserLaunch(browser: ExtensionBrowser, platform: string): Launch {
    const program = PROGRAMS[browser];
    if (platform === "win32") {
        return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", `Start-Process '${program.windows}'`] };
    }
    if (platform === "darwin") return { file: "/usr/bin/open", args: ["-a", program.mac] };
    return { file: program.linux, args: [] };
}
