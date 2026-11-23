/**
 * Polaris Desktop's half of pairing with the browser extension on the same
 * computer: the socket the native messaging host relays the extension's nonce
 * through (`ipc-server`), presenting that nonce to the server over this app's
 * own signed-in session (`pairing`), and the browser manifests that let the
 * extension start the host (`manifests`).
 *
 * Nothing here is shown to anybody. A failure leaves the extension and this app
 * listed separately on the sessions screen, which is how it was before.
 */

import { z } from "zod";
import { join } from "node:path";
import { listen } from "./ipc-server";
import { app, session } from "electron";
import { runReg } from "../mail-handler";
import { presentNonce } from "./pairing";
import { homedir, userInfo } from "node:os";
import { endpointFor, socketDir } from "./ipc-path";
import { deviceHeadersFor } from "../device-headers";
import { STORE_LISTINGS } from "@/shared/install-tools";
import { deviceIdentity } from "../../../../dashboard/packages/core/src/device-identity-node";
import { CHROMIUM_EXTENSION_ID_PATTERN } from "../../../../dashboard/packages/core/src/device-pairing";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { applyManifestPlan, idsInManifest, planManifests, planRemoval, windowsManifestFile, type ManifestIo } from "./manifests";

/** How long a call to the server may take. */
const CALL_TIMEOUT_MS = 20_000;
/** How often the allowed extensions are asked for again while the app runs, so
 *  an extension installed meanwhile can reach the host without a restart. */
const REFRESH_MS = 30 * 60 * 1000;

const HOST_EXE = process.platform === "win32" ? "polaris-native-host.exe" : "polaris-native-host";

const idsSchema = z.object({ runtimeIds: z.array(z.string().regex(CHROMIUM_EXTENSION_ID_PATTERN)).max(200) });

let allowed = new Set<string>();

function dataDir(): string {
    return join(app.getPath("userData"), "native-host");
}

/** The host as shipped in the app's resources, or null when this build has none. */
function shippedHost(): string | null {
    const shipped = join(process.resourcesPath, "native-host", HOST_EXE);
    return app.isPackaged && existsSync(shipped) ? shipped : null;
}

/**
 * Where the manifests point. On Linux a copy beside the socket, because an
 * AppImage's resources sit in a mount that is gone once the app quits, and a
 * browser starts the host whether the app runs or not.
 */
function hostPath(): string | null {
    const shipped = shippedHost();
    if (!shipped || process.platform !== "linux") return shipped;
    const dir = socketDir("linux", homedir(), process.env.XDG_CONFIG_HOME);
    if (!dir) return null;
    const target = join(dir, HOST_EXE);
    try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const same = existsSync(target) && statSync(target).size === statSync(shipped).size && readFileSync(target).equals(readFileSync(shipped));
        if (!same) {
            const temp = `${target}.${process.pid}.tmp`;
            copyFileSync(shipped, temp);
            chmodSync(temp, 0o755);
            renameSync(temp, target);
        }
        return target;
    } catch (error) {
        console.warn("polaris: could not place the native host:", error);
        return null;
    }
}

const io: ManifestIo = {
    readFile: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null),
    writeFile: (file, content) => {
        mkdirSync(join(file, ".."), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, content);
        renameSync(temp, file);
    },
    removeFile: (file) => rmSync(file, { force: true }),
    runReg
};

/** The Chromium ids the manifests allowed last time, from the file on disk. */
function previousIds(): string[] {
    const plan = planManifests({
        platform: process.platform,
        home: homedir(),
        dataDir: dataDir(),
        hostPath: "",
        chromiumIds: ["a".repeat(32)],
        exists: () => true
    });
    const files = process.platform === "win32" ? [windowsManifestFile(dataDir(), "chromium")] : plan.write.map((item) => item.file);
    return [...new Set(files.flatMap((file) => idsInManifest(io.readFile(file) ?? "")))];
}

function storeIds(): string[] {
    return [STORE_LISTINGS.chromeWebStore, STORE_LISTINGS.edgeAddons].filter((id): id is string => !!id && CHROMIUM_EXTENSION_ID_PATTERN.test(id));
}

/** The server's list of this account's extensions; null when it cannot say (signed out, offline, an older server). */
async function fetchExtensionIds(origin: string): Promise<string[] | null> {
    try {
        const response = await session.defaultSession.fetch(`${origin}/api/device-pairing/extensions`, {
            credentials: "include",
            cache: "no-store",
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
        if (!response.ok) return null;
        const read = idsSchema.safeParse(await response.json().catch(() => null));
        return read.success ? read.data.runtimeIds : null;
    } catch {
        return null;
    }
}

/** Write or repair the manifests, with the server's ids when it gives them. */
async function refreshManifests(origin: string | null): Promise<void> {
    const host = hostPath();
    if (!host) return;
    const fetched = origin ? await fetchExtensionIds(origin) : null;
    const ids = [...new Set([...(fetched ?? previousIds()), ...storeIds()])];
    allowed = new Set(ids);
    await applyManifestPlan(
        planManifests({ platform: process.platform, home: homedir(), dataDir: dataDir(), hostPath: host, chromiumIds: ids, exists: existsSync }),
        io
    );
}

async function claim(origin: string, nonce: string): Promise<number | null> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const url = `${origin}/api/device-pairing/claim`;
    Object.assign(headers, deviceHeadersFor(url, origin, await deviceIdentity().catch(() => null)) ?? {});
    try {
        const response = await session.defaultSession.fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ nonce }),
            credentials: "include",
            cache: "no-store",
            signal: AbortSignal.timeout(CALL_TIMEOUT_MS)
        });
        if (response.status !== 200) console.warn(`polaris: the server did not pair the extension (HTTP ${response.status})`);
        return response.status;
    } catch {
        return null;
    }
}

export interface NativeHostContext {
    /** The server the window shows, by its usual address. */
    readonly primary: () => string | null;
    /** The origin requests go to now (the usual address, or a local one while failed over). */
    readonly server: () => string | null;
}

/** Start listening for the host and write the manifests. Packaged builds only. */
export function startNativeHost(context: NativeHostContext): void {
    if (!shippedHost()) return;
    const endpoint = endpointFor(process.platform, userInfo().username, homedir(), process.env.XDG_CONFIG_HOME);
    if (endpoint) {
        void listen(endpoint, (message) =>
            presentNonce(message, {
                servers: () => [context.primary(), context.server()].filter((origin): origin is string => !!origin),
                allowedIds: () => allowed,
                claim
            })
        );
    }
    const refresh = () => void refreshManifests(context.server()).catch((error: unknown) => console.warn("polaris: browser manifests:", error));
    refresh();
    setInterval(refresh, REFRESH_MS).unref();
}

/** Take every manifest and registry entry back off, for the uninstaller. */
export async function removeNativeHost(): Promise<void> {
    await applyManifestPlan(planRemoval(process.platform, homedir(), dataDir()), io);
}
