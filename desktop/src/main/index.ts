/**
 * Polaris for the desktop: a client of one Polaris instance.
 *
 * Unlike a self-contained desktop build, nothing of Polaris runs here - the app
 * opens the instance the person points it at, in windows held to that origin,
 * and adds what a browser tab cannot do: notices drawn by the operating system,
 * a folder zipped from the disk for "Upload a folder", and pushing a build made
 * with this computer's Docker.
 *
 * The first run asks for the address. It is probed at `/api/health` before it is
 * kept, so the form says "that is not Polaris" instead of opening a window onto
 * somebody else's page, and a window that later fails to load comes back to the
 * same form with the reason in words. Every address opened is kept in a list
 * (Servers, in the tray icon - File on macOS), so going to another Polaris and
 * back is a press, not typing.
 */

import { registerIpc } from "./ipc";
import { GameWatcher } from "./game-detect";
import { showNotice } from "./notices";
import { dropApiKey } from "./key-flow";
import { pushRunning } from "./push-local";
import { watchForUpdates } from "./updates";
import { CHANNELS, type Outcome } from "@/shared/bridge";
import { allowPermission } from "./permissions";
import { handledSquirrelEvent } from "./squirrel";
import { installScreenShare } from "./screen-share";
import { installTray } from "./tray";
import { appItems, hideMenuBar, installMenu, type MenuActions, type MenuUpdate } from "./menu";
import { serverAddressSchema } from "@/shared/server-address";
import { listServers, normalizeServerName, renameServer, SERVER_NAME_MAX, withoutServer } from "@/shared/servers";
import { savedServers, serverAddress, setSavedServers, setServerAddress } from "./settings";
import { backIndex, isServerUrl, serverPath } from "./navigation";
import { kindOf, openLocalWindow, openPolarisWindow } from "./windows";
import { app, BrowserWindow, dialog, net, session, shell } from "electron";
import { classifyHealth, describeNetError, describeProbe, netErrorCode } from "./reachability";

/** Where the dashboard opens, the same as the installable app's start page. */
const START = "/home";

let current: string | null = null;
let main: BrowserWindow | null = null;
let connect: BrowserWindow | null = null;
let loadError: string | null = null;

/**
 * The game running on this computer, told to the main window as it changes and
 * every minute while it runs. Only the main window: it is the one page that
 * reports it to Polaris, so a second window open on a log does not report it
 * twice. A game that starts while no window is open is told to the next one as
 * soon as it asks (`gameCurrent`).
 */
const games = new GameWatcher((game) => {
    if (main && !main.isDestroyed()) main.webContents.send(CHANNELS.gameActivity, game);
});

const server = (): string | null => current;

/** Show the Polaris - at a path when one is given - in the main window. */
function showPolaris(path?: string): void {
    if (!current) {
        openConnect();
        return;
    }
    const url = (path && serverPath(path, current)) || null;
    if (main && !main.isDestroyed()) {
        if (url) void main.loadURL(url);
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
        return;
    }
    openMain(url ?? `${current}${START}`);
}

function openMain(url: string): void {
    const window = openPolarisWindow(url, server);
    main = window;
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // -3 is a load that another one replaced: a redirect, a click, nothing wrong.
        if (!isMainFrame || code === -3 || !current || !isServerUrl(url, current)) return;
        loadError = describeNetError(netErrorCode(description), new URL(current).host);
        openConnect();
        window.close();
    });
    window.on("closed", () => {
        if (main === window) main = null;
    });
}

function openConnect(): void {
    if (connect && !connect.isDestroyed()) {
        connect.show();
        connect.focus();
        return;
    }
    const window = openLocalWindow("connect", { title: "Polaris", width: 560, height: 560 });
    connect = window;
    window.on("closed", () => {
        if (connect === window) connect = null;
    });
}

/** Whether an address is a Polaris that can be opened now, and if not, why. */
async function probe(origin: string): Promise<string | null> {
    const host = new URL(origin).host;
    try {
        const response = await net.fetch(`${origin}/api/health`, {
            credentials: "omit",
            cache: "no-store",
            signal: AbortSignal.timeout(10_000)
        });
        // An http address that redirects to https, or an old name that moved: the
        // window may only ever be on the address kept, so the one it lands on is
        // the one to type.
        const landed = new URL(response.url || origin).origin;
        if (landed !== origin) return `${host} sends visitors on to ${landed}. Use that address instead.`;
        const body = await response.json().catch(() => null);
        return describeProbe(classifyHealth(response.status, body), host);
    } catch (caught) {
        if ((caught as Error).name === "TimeoutError") return describeNetError("ERR_TIMED_OUT", host);
        return describeNetError(netErrorCode(String(caught)), host);
    }
}

/** Back in the focused Polaris window, never onto a page that is not the Polaris
 *  (see `backIndex`). */
function goBack(): void {
    const contents = BrowserWindow.getFocusedWindow()?.webContents;
    if (!contents || !current || kindOf(contents) !== "polaris") return;
    const history = contents.navigationHistory;
    const urls = history.getAllEntries().map((entry) => entry.url);
    const index = backIndex(urls, history.getActiveIndex(), current);
    if (index !== null) history.goToIndex(index);
}

async function connectSubmit(raw: unknown): Promise<Outcome> {
    const parsed = serverAddressSchema.safeParse(typeof raw === "string" ? raw : "");
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That is not an address." };
    const origin = parsed.data;
    const problem = await probe(origin);
    if (problem) return { ok: false, error: problem };

    const changed = origin !== current;
    setServerAddress(origin);
    if (changed) leaveServer();
    current = origin;
    loadError = null;
    refreshMenu();
    showPolaris();
    connect?.close();
    return { ok: true };
}

/** Every window on the instance in use goes: none of them may stay open on an
 *  origin the navigation rules no longer allow. */
function leaveServer(): void {
    for (const window of BrowserWindow.getAllWindows()) if (window !== connect) window.close();
    main = null;
}

function servers() {
    return listServers(savedServers(), current);
}

/** Open a server from the list. The same door as typing its address, so it is
 *  probed first and an unreachable one says why instead of opening a blank window. */
function switchServer(origin: string): Promise<Outcome> {
    if (!savedServers().some((server) => server.origin === origin)) {
        return Promise.resolve({ ok: false, error: "That server is not in the list any more." });
    }
    return connectSubmit(origin);
}

function nameServer(origin: string, typed: string): Outcome {
    const name = normalizeServerName(typed);
    if (name && name.length > SERVER_NAME_MAX) return { ok: false, error: `Use at most ${SERVER_NAME_MAX} characters.` };
    setSavedServers(renameServer(savedServers(), origin, name));
    refreshMenu();
    return { ok: true };
}

/** Take a server off the list. Removing the one in use closes its windows and
 *  leaves the list open to pick another; its sign-in is not touched. */
function removeServer(origin: string): Outcome {
    if (origin === current) {
        setServerAddress(null);
        current = null;
        leaveServer();
    }
    setSavedServers(withoutServer(savedServers(), origin));
    refreshMenu();
    return { ok: true };
}

let menuUpdate: MenuUpdate | undefined;
let menuActions: MenuActions | null = null;

function refreshMenu(): void {
    if (!menuActions) return;
    installMenu(menuActions, menuUpdate, servers());
    installTray(appItems(menuActions, menuUpdate, servers()), () => showPolaris());
}

function start(): void {
    current = serverAddress();

    app.on("browser-window-created", (_event, window) => hideMenuBar(window));

    app.on("web-contents-created", (_event, contents) => {
        contents.on("will-attach-webview", (event) => event.preventDefault());
    });

    app.whenReady().then(() => {
        if (process.platform === "win32" && !app.isPackaged) app.setAppUserModelId(process.execPath);

        session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
            callback(allowPermission(permission, details.requestingUrl, current));
        });
        session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
            allowPermission(permission, requestingOrigin, current)
        );

        registerIpc({
            server,
            showPolaris,
            runningGame: () => games.running(),
            isReporter: (sender) => Boolean(main && !main.isDestroyed() && main.webContents === sender),
            setCustomGames: (list) => games.setCustomGames(list),
            connectState: () => ({ address: current, error: loadError, servers: servers() }),
            connectSubmit,
            switchServer,
            nameServer,
            removeServer
        });

        installScreenShare(server);
        games.start();

        const menu: MenuActions = {
            changeServer: openConnect,
            switchServer: (origin) => {
                void switchServer(origin).then((outcome) => {
                    if (!outcome.ok) {
                        loadError = outcome.error;
                        openConnect();
                    }
                });
            },
            back: goBack,
            reload: () => BrowserWindow.getFocusedWindow()?.webContents.reload(),
            forgetApiKey: () => {
                if (current) dropApiKey(current);
                void dialog.showMessageBox({
                    type: "info",
                    message: "The saved API key was removed from this computer.",
                    detail: "It still works until it is revoked in Polaris, under Account > API keys."
                });
            },
            openApiKeys: () => showPolaris("/account/api-keys"),
            openInBrowser: () => {
                if (current) void shell.openExternal(current);
            }
        };
        menuActions = menu;
        refreshMenu();
        watchForUpdates((update) => {
            const open = () => void shell.openExternal(update.page);
            menuUpdate = { version: update.version, open, ...(update.restart ? { restart: update.restart } : {}) };
            refreshMenu();
            showNotice(
                update.restart
                    ? {
                          title: `Polaris ${update.version} is installed`,
                          body: "It opens the next time Polaris starts. Click to restart now.",
                          tag: "desktop-update",
                          onClick: update.restart
                      }
                    : {
                          title: `Polaris ${update.version} is available`,
                          body:
                              process.platform === "darwin"
                                  ? "Open its download page from here or from the Help menu."
                                  : "Open its download page from here or from the Polaris icon in the taskbar.",
                          tag: "desktop-update",
                          onClick: open
                      }
            );
        });

        if (current) openMain(`${current}${START}`);
        else openConnect();

        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) showPolaris();
        });
    });

    app.on("second-instance", () => showPolaris());

    app.on("window-all-closed", () => {
        if (process.platform !== "darwin") app.quit();
    });

    let confirmedQuit = false;
    app.on("before-quit", (event) => {
        if (confirmedQuit || !pushRunning()) return;
        event.preventDefault();
        const choice = dialog.showMessageBoxSync({
            type: "warning",
            buttons: ["Keep pushing", "Quit"],
            defaultId: 0,
            cancelId: 0,
            message: "A push is still running.",
            detail: "Quitting stops the build or the upload. A deployment Polaris has already started carries on."
        });
        if (choice === 1) {
            confirmedQuit = true;
            app.quit();
        }
    });
}

if (!handledSquirrelEvent()) {
    if (app.requestSingleInstanceLock()) start();
    else app.quit();
}
