/**
 * The native messaging host manifests that let the Polaris extension start
 * `polaris-native-host`, for Chrome, Chromium, Edge, Brave and Firefox.
 *
 * Written again on every start, since the app's folder - and so the host's
 * path - moves with each version, and an install from before this existed has
 * none. Taken back off by the uninstaller (`squirrel.ts`, the .deb's postrm).
 *
 * Where each browser reads them (the same places Bitwarden's desktop app writes,
 * apps/desktop/src/main/native-messaging.main.ts):
 * - Chrome, Chromium: developer.chrome.com/docs/extensions/develop/concepts/native-messaging
 * - Edge: learn.microsoft.com/microsoft-edge/extensions/developer-guide/native-messaging
 * - Brave: its own registry key and `BraveSoftware/Brave-Browser` profile folder, as Bitwarden uses
 * - Firefox: developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/Native_manifests
 *
 * On Windows each browser has an HKCU key whose default value is the path of a
 * manifest file kept in this app's data folder. On macOS and Linux the manifest
 * file goes in the browser's own folder, and only when that browser is
 * installed (its folder exists), so nothing is created for one that is not.
 *
 * Only extensions named here may start the host: the ids the server lists for
 * the signed-in account plus the store listings', and the Firefox add-on's
 * fixed id. Never a wildcard; with no Chromium id known, the Chromium manifests
 * are removed rather than written empty.
 *
 * Planning is pure; `applyManifestPlan` does the writing.
 */

import { posix, win32 } from "node:path";
import type { RegCommand } from "../mail-handler";
import { FIREFOX_EXTENSION_ID, NATIVE_HOST_NAME } from "../../../../dashboard/packages/core/src/device-pairing";

export type ManifestFamily = "chromium" | "firefox";

const DESCRIPTION = "Polaris Desktop: pairs the Polaris extension with this computer.";

/** The manifest's contents, or null for a Chromium manifest no extension could use. */
export function manifestFor(family: ManifestFamily, hostPath: string, chromiumIds: readonly string[]): object | null {
    const base = { name: NATIVE_HOST_NAME, description: DESCRIPTION, path: hostPath, type: "stdio" };
    if (family === "firefox") return { ...base, allowed_extensions: [FIREFOX_EXTENSION_ID] };
    if (!chromiumIds.length) return null;
    return { ...base, allowed_origins: [...new Set(chromiumIds)].sort().map((id) => `chrome-extension://${id}/`) };
}

/** The Chromium ids a manifest written earlier allowed, to keep while the server cannot be asked. */
export function idsInManifest(text: string): string[] {
    try {
        const origins: unknown = (JSON.parse(text) as { allowed_origins?: unknown; }).allowed_origins;
        if (!Array.isArray(origins)) return [];
        return origins.flatMap((origin) => {
            const match = typeof origin === "string" ? /^chrome-extension:\/\/([a-p]{32})\/$/.exec(origin) : null;
            return match?.[1] ? [match[1]] : [];
        });
    } catch {
        return [];
    }
}

/** HKCU keys, per browser, under which Windows browsers look for the host. */
const WINDOWS_KEYS: readonly { readonly family: ManifestFamily; readonly key: string; }[] = [
    { family: "chromium", key: "Software\\Google\\Chrome\\NativeMessagingHosts" },
    { family: "chromium", key: "Software\\Chromium\\NativeMessagingHosts" },
    { family: "chromium", key: "Software\\Microsoft\\Edge\\NativeMessagingHosts" },
    { family: "chromium", key: "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts" },
    { family: "firefox", key: "Software\\Mozilla\\NativeMessagingHosts" }
];

/** Each browser's own folder (which must exist) and the folder its manifests go in, relative to home. */
function unixFolders(platform: NodeJS.Platform): readonly { family: ManifestFamily; browser: string; hosts: string; }[] {
    if (platform === "darwin") {
        const support = "Library/Application Support";
        return [
            { family: "chromium", browser: `${support}/Google/Chrome`, hosts: "NativeMessagingHosts" },
            { family: "chromium", browser: `${support}/Chromium`, hosts: "NativeMessagingHosts" },
            { family: "chromium", browser: `${support}/Microsoft Edge`, hosts: "NativeMessagingHosts" },
            { family: "chromium", browser: `${support}/BraveSoftware/Brave-Browser`, hosts: "NativeMessagingHosts" },
            { family: "firefox", browser: `${support}/Mozilla`, hosts: "NativeMessagingHosts" }
        ];
    }
    return [
        { family: "chromium", browser: ".config/google-chrome", hosts: "NativeMessagingHosts" },
        { family: "chromium", browser: ".config/chromium", hosts: "NativeMessagingHosts" },
        { family: "chromium", browser: ".config/microsoft-edge", hosts: "NativeMessagingHosts" },
        { family: "chromium", browser: ".config/BraveSoftware/Brave-Browser", hosts: "NativeMessagingHosts" },
        { family: "firefox", browser: ".mozilla", hosts: "native-messaging-hosts" }
    ];
}

export interface ManifestPlan {
    /** Files to write, with their contents. */
    readonly write: readonly { readonly file: string; readonly content: string; }[];
    /** Files to remove when present. */
    readonly remove: readonly string[];
    /** `reg.exe` calls, in order (Windows only). */
    readonly registry: readonly RegCommand[];
}

export interface PlanInput {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    /** Windows: the folder the manifest files are kept in. */
    readonly dataDir: string;
    /** Where the host binary is. */
    readonly hostPath: string;
    readonly chromiumIds: readonly string[];
    /** macOS and Linux: whether a folder exists. */
    readonly exists: (dir: string) => boolean;
}

/** Windows: the manifest file for a family. */
export function windowsManifestFile(dataDir: string, family: ManifestFamily): string {
    return win32.join(dataDir, `${NATIVE_HOST_NAME}.${family}.json`);
}

const json = (value: object) => `${JSON.stringify(value, null, 2)}\n`;

/** What to write and remove so the manifests match `input`. */
export function planManifests(input: PlanInput): ManifestPlan {
    const write: { file: string; content: string; }[] = [];
    const remove: string[] = [];
    const registry: RegCommand[] = [];
    if (input.platform === "win32") {
        for (const family of ["chromium", "firefox"] as const) {
            const file = windowsManifestFile(input.dataDir, family);
            const manifest = manifestFor(family, input.hostPath, input.chromiumIds);
            if (manifest) write.push({ file, content: json(manifest) });
            else remove.push(file);
            for (const entry of WINDOWS_KEYS.filter((item) => item.family === family)) {
                const key = `HKCU\\${entry.key}\\${NATIVE_HOST_NAME}`;
                registry.push(manifest ? ["add", key, "/ve", "/t", "REG_SZ", "/d", file, "/f"] : ["delete", key, "/f"]);
            }
        }
        return { write, remove, registry };
    }
    for (const folder of unixFolders(input.platform)) {
        const file = posix.join(input.home, folder.browser, folder.hosts, `${NATIVE_HOST_NAME}.json`);
        const manifest = manifestFor(folder.family, input.hostPath, input.chromiumIds);
        if (manifest && input.exists(posix.join(input.home, folder.browser))) write.push({ file, content: json(manifest) });
        else remove.push(file);
    }
    return { write, remove, registry };
}

/** Everything the app ever writes, for the uninstaller. */
export function planRemoval(platform: NodeJS.Platform, home: string, dataDir: string): ManifestPlan {
    if (platform === "win32") {
        return {
            write: [],
            remove: (["chromium", "firefox"] as const).map((family) => windowsManifestFile(dataDir, family)),
            registry: WINDOWS_KEYS.map((entry): RegCommand => ["delete", `HKCU\\${entry.key}\\${NATIVE_HOST_NAME}`, "/f"])
        };
    }
    return {
        write: [],
        remove: unixFolders(platform).map((folder) => posix.join(home, folder.browser, folder.hosts, `${NATIVE_HOST_NAME}.json`)),
        registry: []
    };
}

export interface ManifestIo {
    readonly readFile: (file: string) => string | null;
    readonly writeFile: (file: string, content: string) => void;
    readonly removeFile: (file: string) => void;
    readonly runReg: (commands: readonly RegCommand[]) => Promise<void>;
}

/** Carry a plan out. A file already holding the same contents is left alone;
 *  one that cannot be written is logged and the rest still are. */
export async function applyManifestPlan(plan: ManifestPlan, io: ManifestIo): Promise<void> {
    for (const { file, content } of plan.write) {
        try {
            if (io.readFile(file) !== content) io.writeFile(file, content);
        } catch (error) {
            console.warn(`polaris: could not write the browser manifest ${file}:`, error);
        }
    }
    for (const file of plan.remove) {
        try {
            io.removeFile(file);
        } catch {
            // Not there is the state this wants.
        }
    }
    if (plan.registry.length) await io.runReg(plan.registry);
}
