/**
 * Polaris for the desktop: a client of one Polaris instance.
 *
 * Unlike a self-contained desktop build, nothing of Polaris runs here - the app
 * opens the instance the person points it at, in windows held to that origin,
 * and adds what a browser tab cannot do: notices drawn by the operating system,
 * a folder zipped from the disk for "Upload a folder", and pushing a build made
 * with this computer's Docker.
 *
 * The first run asks for the address. It is asked whether it is a Polaris
 * (`shared/server-identity`) as it is typed and again before it is kept, so the form says "that is not Polaris" instead of opening a window onto
 * somebody else's page, and a window that later fails to load comes back to the
 * same form with the reason in words. Every address opened is kept in a list
 * (Servers, in the tray icon - File on macOS), so going to another Polaris and
 * back is a press, not typing.
 */

import { openTvInstall } from "./tv-install";
import { registerIpc } from "./ipc";
import { DEEP_LINK_SCHEME, deepLinkIn, readDeepLink } from "@/shared/deep-link";
import { DeepLinks } from "./deep-links";
import { GameWatcher } from "./game-detect";
import { showNotice } from "./notices";
import { dropApiKey } from "./key-flow";
import { pushRunning } from "./push-local";
import { watchForUpdates, type Update } from "./updates";
import { updateBeforeOpening, type Opening } from "./update-first";
import { UpdateReadyState } from "./update-ready";
import { CHANNELS, type AddressCheck, type Outcome } from "@/shared/bridge";
import { allowPermission } from "./permissions";
import { handledSquirrelEvent } from "./squirrel";
import { installScreenShare } from "./screen-share";
import { installTray } from "./tray";
import { appItems, hideMenuBar, installMenu, type MenuActions, type MenuUpdate } from "./menu";
import { serverAddressSchema } from "@/shared/server-address";
import { listServers, normalizeServerName, renameServer, SERVER_NAME_MAX, withoutServer } from "@/shared/servers";
import { setOpenAtLogin } from "./login-item";
import { restoredPlace } from "@/shared/window-place";
import * as settings from "./settings";
import { savedServers, serverAddress, setSavedServers, setServerAddress, setUpdateAttempted, updateAttempted } from "./settings";
import { backIndex, isServerUrl, serverPath } from "./navigation";
import { kindOf, openLocalSheet, openLocalWindow, openPolarisWindow, type LocalSheet } from "./windows";
import { app, BrowserWindow, dialog, net, screen, session, shell } from "electron";
import { describeNetError, finishedLoad, netErrorCode } from "./reachability";
import { createServerCheck, describeVerdict, type ServerVerdict } from "@/shared/server-identity";

/** Where the dashboard opens, the same as the installable app's start page. */
const START = "/home";

let current: string | null = null;
let main: BrowserWindow | null = null;
let connect: BrowserWindow | null = null;
/** The settings laid over the Polaris window, when there is one to lay them on. */
let sheet: LocalSheet | null = null;
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

/**
 * The update installed and waiting for a restart, told to every Polaris window
 * as it changes so the page's header can offer the restart. A window opened
 * later asks for it (`updateCurrent`).
 */
/** The page of the Polaris window in front - the focused one, else the main
 *  one - by its web contents, or null when neither is a Polaris page. */
function frontPage(): number | null {
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused && kindOf(focused.webContents) === "polaris" ? focused : main;
    if (!window || window.isDestroyed() || !current || !isServerUrl(window.webContents.getURL(), current)) return null;
    return window.webContents.id;
}

const updates = new UpdateReadyState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents;
        if (contents.isDestroyed() || kindOf(contents) !== "polaris") continue;
        if (current && isServerUrl(contents.getURL(), current)) contents.send(CHANNELS.updateReady, state);
    }
});

/** Show the Polaris - at a path when one is given - in the main window. */
function showPolaris(path?: string): void {
    if (updating && !updating.isDestroyed()) {
        updating.show();
        updating.focus();
        return;
    }
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

/** Ask before a link leaves the Polaris in use. No is the default: a website may
 *  have started it. */
async function confirmSwitch(origin: string): Promise<boolean> {
    const { response } = await dialog.showMessageBox({
        type: "question",
        buttons: ["Switch", "Stay here"],
        defaultId: 1,
        cancelId: 1,
        message: `Switch to ${new URL(origin).host}?`,
        detail: "A link asked to open a page there. Switching closes the Polaris windows open now."
    });
    return response === 0;
}

const deepLinks = new DeepLinks(
    {
        current: server,
        saved: () => savedServers().map((saved) => saved.origin),
        show: showPolaris,
        confirmSwitch,
        switchTo: switchOrSayWhy,
        openInBrowser: (url) => void shell.openExternal(url)
    },
    deepLinkIn(process.argv)
);

/** The first window: what the app was started for, and always something on
 *  screen, since a link the browser took opens nothing here. */
function showOpening(): void {
    deepLinks.opened();
    if (!main && !connect) showPolaris();
}

/** The window shown while an update goes in before the app opens. */
let updating: BrowserWindow | null = null;
/** Show that an update is going in. Settles when the window is closed. */
function showUpdating(): Promise<void> {
    const window = openLocalWindow("updating", { title: "Polaris", width: 380, height: 360 });
    updating = window;
    return new Promise((resolve) => {
        window.on("closed", () => {
            if (updating === window) updating = null;
            resolve();
        });
    });
}

/** How long a window has to sit still before where it is gets written down. */
const PLACE_SETTLES_MS = 400;

/** Where the main window opens: where it was, if that place still exists. */
function savedPlace(): ReturnType<typeof restoredPlace> | undefined {
    const place = settings.windowPlace();
    if (!place) return undefined;
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    return restoredPlace(place, areas, screen.getPrimaryDisplay().workArea);
}

/** Keep where the window is, and write it once more on closing: an update closes it. */
function rememberPlace(window: BrowserWindow): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
        clearTimeout(timer);
        if (window.isDestroyed() || window.isFullScreen()) return;
        settings.setWindowPlace({ ...window.getNormalBounds(), maximized: window.isMaximized() });
    };
    const settle = () => {
        clearTimeout(timer);
        timer = setTimeout(write, PLACE_SETTLES_MS);
    };
    window.on("resize", settle);
    window.on("move", settle);
    window.on("maximize", settle);
    window.on("unmaximize", settle);
    window.on("close", write);
}

function openMain(url: string): void {
    const window = openPolarisWindow(url, server, savedPlace());
    main = window;
    rememberPlace(window);
    let offline = false;
    window.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
        // -3 is a load that another one replaced: a redirect, a click, nothing wrong.
        if (!isMainFrame || code === -3 || !current || !isServerUrl(url, current)) return;
        offline = false;
        loadError = describeNetError(netErrorCode(description), new URL(current).host);
        openConnect();
        window.close();
    });
    // The Polaris's own worker answers for it when it is gone, so this load succeeded.
    // The window stays for its Try again; the servers window is the way to the others.
    window.webContents.on("did-finish-load", () => {
        if (!current) return;
        const load = finishedLoad(window.webContents.getTitle(), offline);
        offline = load === "offline";
        if (load === "recovered") loadError = null;
        if (!offline) return;
        loadError = describeNetError(null, new URL(current).host);
        openConnect();
    });
    window.on("closed", () => {
        if (main === window) main = null;
    });
}

function openConnect(): void {
    if (sheet && !sheet.isDestroyed()) {
        sheet.focus();
        return;
    }
    if (connect && !connect.isDestroyed()) {
        connect.show();
        connect.focus();
        return;
    }
    // Over Polaris when it is on screen; a window of its own on the first run, or
    // when there is no Polaris window to lay it on.
    if (main && !main.isDestroyed() && main.isVisible()) {
        if (main.isMinimized()) main.restore();
        main.focus();
        const opened = openLocalSheet(main, "connect", () => {
            if (sheet === opened) sheet = null;
        });
        sheet = opened;
        return;
    }
    const window = openLocalWindow("connect", { title: "Polaris", width: 560, height: 560 });
    connect = window;
    window.on("closed", () => {
        if (connect === window) connect = null;
    });
}

/** Put the settings away, sheet or window. */
function closeConnect(): void {
    sheet?.close();
    connect?.close();
}

/** Every answer about an address, kept briefly so typing it again asks nothing. */
const serverCheck = createServerCheck((input, init) => net.fetch(input, init));
/** The one live check in flight; a newer address cancels it. */
let checking: AbortController | null = null;

/** What the servers window says about an address: the verdict, in words. */
function verdictWords(verdict: ServerVerdict, origin: string): string {
    const host = new URL(origin).host;
    if (verdict.kind === "unreachable") return describeNetError(netErrorCode(verdict.cause ?? ""), host);
    return describeVerdict(verdict, host);
}

/** Whether an address is a Polaris that can be opened now, and if not, why. */
async function probe(origin: string): Promise<string | null> {
    const verdict = await serverCheck.check(origin);
    return verdict.kind === "polaris" ? null : verdictWords(verdict, origin);
}

/** The servers window asking about the address in its field while it is typed. */
async function connectCheck(raw: unknown): Promise<AddressCheck> {
    const parsed = serverAddressSchema.safeParse(typeof raw === "string" ? raw : "");
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "That is not an address." };
    checking?.abort();
    const controller = new AbortController();
    checking = controller;
    try {
        const verdict = await serverCheck.check(parsed.data, controller.signal);
        return { ok: verdict.kind === "polaris", message: verdictWords(verdict, parsed.data) };
    } catch {
        return { ok: false, message: null };
    } finally {
        if (checking === controller) checking = null;
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
    closeConnect();
    return { ok: true };
}

/** Every window on the instance in use goes: none of them may stay open on an
 *  origin the navigation rules no longer allow. */
function leaveServer(): void {
    sheet?.close();
    for (const window of BrowserWindow.getAllWindows()) if (window !== connect) window.close();
    main = null;
    updating = null;
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

/** Open a server from the list, and if that fails, say why in the servers window. */
async function switchOrSayWhy(origin: string): Promise<boolean> {
    const outcome = await switchServer(origin);
    if (outcome.ok) return true;
    loadError = outcome.error;
    openConnect();
    return false;
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
        // The sheet goes with the Polaris window, so the list comes back in a
        // window of its own to pick another.
        const listOpen = Boolean(sheet);
        setServerAddress(null);
        current = null;
        leaveServer();
        if (listOpen) openConnect();
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
    // Windows reports a window behind a full-screen game as gone, and Chromium then
    // starves it, along with the call inside.
    app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    current = serverAddress();

    app.on("browser-window-created", (_event, window) => hideMenuBar(window));

    app.on("web-contents-created", (_event, contents) => {
        contents.on("will-attach-webview", (event) => event.preventDefault());
    });

    app.whenReady().then(() => {
        if (process.platform === "win32" && !app.isPackaged) app.setAppUserModelId(process.execPath);
        // Every start: the app's folder moves with each version, and the setting has
        // to reach installs from before it existed.
        setOpenAtLogin(settings.openAtLogin());
        if (app.isPackaged) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

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
            preferences: () => ({ openAtLogin: settings.openAtLogin(), version: app.getVersion() }),
            setOpenAtLogin: (open) => {
                if (!setOpenAtLogin(open)) return false;
                settings.rememberOpenAtLogin(open);
                return true;
            },
            connectSubmit,
            connectCheck,
            switchServer,
            nameServer,
            removeServer,
            closeConnect,
            openServers: openConnect,
            updates
        });

        installScreenShare(server);
        games.start();

        const menu: MenuActions = {
            changeServer: openConnect,
            switchServer: (origin) => void switchOrSayWhy(origin),
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
            installOnTv: openTvInstall,
            openInBrowser: () => {
                if (current) void shell.openExternal(current);
            }
        };
        menuActions = menu;
        refreshMenu();
        const announce = (update: Update) => {
            const open = () => void shell.openExternal(update.page);
            // The window in front draws the restart button itself: no notice
            // on top of it. A page that does not (an older Polaris, the address
            // form) gets the notice, as do the other windows' pages through the
            // button they draw.
            if (!updates.needsNotice(update, frontPage())) return;
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
                              process.platform === "win32"
                                  ? "Open its download page from here or from the Polaris icon in the taskbar."
                                  : process.platform === "linux"
                                    ? "Open its download page from here or from the Help menu, which Alt opens."
                                    : "Open its download page from here or from the Help menu.",
                          tag: "desktop-update",
                          onClick: open
                      }
            );
        };
        /** The update the app was about to restart into, unannounced until it opens. */
        let heldBack: Update | null = null;
        const first = watchForUpdates((update) => {
            menuUpdate = {
                version: update.version,
                open: () => void shell.openExternal(update.page),
                ...(update.restart ? { restart: update.restart } : {})
            };
            refreshMenu();
            updates.found(update);
            // The app is about to restart into it: nothing to announce.
            if (updating && update.restart) {
                heldBack = update;
                return;
            }
            announce(update);
        });

        void updateBeforeOpening(first, {
            attempted: updateAttempted,
            attempt: setUpdateAttempted,
            opened: () => main !== null,
            showUpdating,
            restart: () => updates.install().ok
        })
            .catch((): Opening => "open")
            .then((opening) => {
                app.on("activate", () => {
                    if (BrowserWindow.getAllWindows().length === 0) showOpening();
                });
                if (opening !== "open") {
                    deepLinks.opened();
                    return;
                }
                // The app opens first: closing the last window would quit it.
                const waited = updating;
                updating = null;
                showOpening();
                waited?.close();
                if (heldBack) announce(heldBack);
            });
    });

    app.on("second-instance", (_event, argv) => {
        const link = deepLinkIn(argv);
        if (link) deepLinks.arrive(link);
        if (!link || updating) showPolaris();
    });
    app.on("open-url", (event, url) => {
        event.preventDefault();
        const link = readDeepLink(url);
        if (link) deepLinks.arrive(link);
    });

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
