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
 * same form with the reason in words - unless the address simply stopped
 * answering and the same Polaris proves itself on a local address, which the
 * window then uses until the usual one answers again (`window-failover`).
 * Every address opened is kept in a list
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
import { watchForUpdates, type FirstCheck, type Update } from "./updates";
import { updateBeforeOpening, type Opening } from "./update-first";
import { UpdateReadyState } from "./update-ready";
import { CHANNELS, type AddressCheck, type Outcome } from "@/shared/bridge";
import { allowPermission } from "./permissions";
import { handledSquirrelEvent } from "./squirrel";
import { installScreenShare } from "./screen-share";
import { installTray } from "./tray";
import { appItems, hideMenuBar, installMenu, type MenuActions, type MenuUpdate } from "./menu";
import { serverAddressSchema } from "@/shared/server-address";
import { listServers, normalizeServerName, renameServer, sameInstanceWords, SERVER_NAME_MAX, withoutServer } from "@/shared/servers";
import { setOpenAtLogin } from "./login-item";
import { restoredPlace } from "@/shared/window-place";
import * as settings from "./settings";
import { savedServers, serverAddress, setSavedServers, setServerAddress, setUpdateAttempted, updateAttempted } from "./settings";
import { backIndex, isServerUrl, serverPath } from "./navigation";
import { kindOf, openLocalSheet, openLocalWindow, openPolarisWindow, type LocalSheet } from "./windows";
import { app, BrowserWindow, dialog, net, screen, session, shell } from "electron";
import { describeNetError, finishedLoad, isCertificateError, netErrorCode } from "./reachability";
import { sameInstanceAs } from "./same-instance";
import { addressWords, failoverFor } from "./polaris-api";
import { activeOrigin, backStep, failedLoadStep, samePlaceOn, titleWith } from "./window-failover";
import { DEFAULT_HOLD_MS, UNTRUSTED_WORDS } from "../../../dashboard/packages/core/src/instance-fallback";
import { createServerCheck, describeVerdict, type ServerVerdict } from "@/shared/server-identity";

/** Where the dashboard opens, the same as the installable app's start page. */
const START = "/home";

let current: string | null = null;
/** The updater, once it is watching: what "Check for updates" asks. */
let updateWatch: FirstCheck | null = null;
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

/**
 * The same Polaris on a local address that proved it is this instance, while
 * the usual address is not answering and the windows are on it; else null.
 * `current` stays the usual address - the server's identity for its key, its
 * settings and its place on the list.
 */
let alternate: string | null = null;
/** Asks the usual address again while the windows are on the alternate. */
let recheck: ReturnType<typeof setInterval> | null = null;

/** The one origin Polaris windows may be on right now (see `activeOrigin`). */
const server = (): string | null => activeOrigin(current, alternate);

/** Back to the usual address for good: a server switched or removed, or the usual one answering again. */
function dropAlternate(): void {
    alternate = null;
    if (recheck) clearInterval(recheck);
    recheck = null;
}

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
    const origin = server();
    if (!window || window.isDestroyed() || !origin || !isServerUrl(window.webContents.getURL(), origin)) return null;
    return window.webContents.id;
}

const updates = new UpdateReadyState((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
        const contents = window.webContents;
        if (contents.isDestroyed() || kindOf(contents) !== "polaris") continue;
        const origin = server();
        if (origin && isServerUrl(contents.getURL(), origin)) contents.send(CHANNELS.updateReady, state);
    }
});

/** Show the Polaris - at a path when one is given - in the main window. */
function showPolaris(path?: string): void {
    if (updating && !updating.isDestroyed()) {
        updating.show();
        updating.focus();
        return;
    }
    const origin = server();
    if (!origin) {
        openConnect();
        return;
    }
    const url = (path && serverPath(path, origin)) || null;
    if (main && !main.isDestroyed()) {
        if (url) void main.loadURL(url);
        if (main.isMinimized()) main.restore();
        main.show();
        main.focus();
        return;
    }
    openMain(url ?? `${origin}${START}`);
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
        current: () => current,
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

/**
 * Where the same Polaris answers now, as the failover in `polaris-api` finds it:
 * a local address only after it signed a fresh challenge with the key learned
 * over the usual one, over TLS this computer already trusts. Null when nothing
 * was learned about the server yet.
 */
async function provenAddress(): Promise<{ readonly origin: string; readonly untrusted: boolean; } | null> {
    const primary = current;
    const failover = primary ? failoverFor(primary) : undefined;
    if (!primary || !failover) return null;
    const origin = await failover.resolve().catch(() => primary);
    return { origin, untrusted: failover.status().untrusted.length > 0 };
}

/** Put the main window on `to` - an alternate the failover proved, or null for
 *  the usual address - at the place it is on now. */
function moveTo(window: BrowserWindow, to: string | null, from = window.webContents.getURL()): void {
    const primary = current;
    if (!primary) return;
    const origin = to ?? primary;
    if (to) {
        alternate = to;
        watchForPrimary(window);
    } else dropAlternate();
    window.setTitle(titleWith(window.webContents.getTitle(), to ? addressWords(primary) : null));
    void window.loadURL(samePlaceOn(from, origin) ?? `${origin}${START}`);
}

/** Ask the usual address again on the failover's own rhythm while the window is
 *  on the alternate, and go back once it answers. */
function watchForPrimary(window: BrowserWindow): void {
    if (recheck) clearInterval(recheck);
    // One wait for the person to leave the window, however many rechecks find the usual address answering.
    let waitingForBlur = false;
    recheck = setInterval(() => {
        const primary = current;
        const failover = primary ? failoverFor(primary) : undefined;
        if (!primary || !failover || !alternate || window.isDestroyed()) {
            dropAlternate();
            return;
        }
        void failover
            .resolve()
            .then((resolved) => {
                if (current !== primary || !alternate || window.isDestroyed()) return;
                const step = backStep(resolved, primary, window.isFocused());
                if (step === "now") moveTo(window, null);
                if (step !== "on-blur" || waitingForBlur) return;
                waitingForBlur = true;
                window.once("blur", () => {
                    waitingForBlur = false;
                    if (current === primary && alternate && !window.isDestroyed()) moveTo(window, null);
                });
            })
            .catch(() => undefined);
    }, DEFAULT_HOLD_MS);
}

/**
 * The address the window is on did not answer at `failedUrl`: go to the same
 * Polaris elsewhere if one proves itself. Answers whether that is in hand, or
 * why not - `untrusted` when a local address failed only on its certificate.
 */
async function failOver(window: BrowserWindow, failedUrl: string): Promise<"moved" | "none" | "untrusted"> {
    const primary = current;
    const found = await provenAddress().catch(() => null);
    if (!primary || current !== primary || window.isDestroyed()) return "moved";
    if (found && found.origin !== primary) {
        if (found.origin !== alternate) {
            showNotice({ title: "Polaris", body: addressWords(primary) ?? undefined, tag: "polaris-address", silent: true, once: true });
        }
        moveTo(window, found.origin, failedUrl);
        return "moved";
    }
    if (alternate) {
        // The alternate stopped answering: the usual address gets one more go, and
        // its own failure comes back here with no alternate left.
        moveTo(window, null, failedUrl);
        return "moved";
    }
    return found?.untrusted ? "untrusted" : "none";
}

function openMain(url: string): void {
    const window = openPolarisWindow(url, server, savedPlace());
    main = window;
    rememberPlace(window);
    let offline = false;
    let failingOver = false;

    /** Say why in the servers window, in place of this one. */
    const giveUp = (error: string) => {
        loadError = error;
        dropAlternate();
        if (main === window) main = null;
        window.close();
        openConnect();
    };

    window.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
        const origin = server();
        if (!isMainFrame || !origin) return;
        const step = failedLoadStep(code, description, failedUrl, origin);
        if (step === "ignore") return;
        offline = false;
        const error = describeNetError(netErrorCode(description), new URL(origin).host);
        if (step === "error") return giveUp(error);
        if (failingOver) return;
        failingOver = true;
        void failOver(window, failedUrl).then((outcome) => {
            failingOver = false;
            if (outcome !== "moved") giveUp(outcome === "untrusted" ? `${error} ${UNTRUSTED_WORDS}` : error);
        });
    });
    // The Polaris's own worker answers for it when it is gone, so this load
    // succeeded. That is the address not answering, so the same Polaris is looked
    // for elsewhere first; failing that the window stays for its Try again, and the
    // servers window is the way to the others.
    window.webContents.on("did-finish-load", () => {
        if (!current) return;
        const load = finishedLoad(window.webContents.getTitle(), offline);
        offline = load === "offline";
        if (load === "recovered") loadError = null;
        if (!offline) {
            // Online on the usual address: learn, or refresh, where else it answers,
            // so the next outage - or a start without internet - can use it.
            if (!alternate) failoverFor(current);
            return;
        }
        if (failingOver) return;
        failingOver = true;
        const host = new URL(server() ?? current).host;
        void failOver(window, window.webContents.getURL()).then((outcome) => {
            failingOver = false;
            if (outcome === "moved" || window.isDestroyed()) return;
            loadError = describeNetError(null, host);
            if (outcome === "untrusted") loadError = `${loadError} ${UNTRUSTED_WORDS}`;
            openConnect();
        });
    });
    // The page's own title, with the words while on the alternate: the quiet sign of it.
    window.on("page-title-updated", (event, title) => {
        if (!alternate || !current) return;
        event.preventDefault();
        window.setTitle(titleWith(title, addressWords(current)));
    });
    window.on("closed", () => {
        if (main !== window) return;
        main = null;
        // The next window starts on the usual address and fails over again if it
        // has to, rather than inheriting an alternate nobody is watching.
        dropAlternate();
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

/**
 * The sentence for an address that is a Polaris already listed under another
 * name, or null. Asked for a Polaris that answered, and for an address whose
 * certificate this computer does not trust - the usual reason a local name of
 * the same Polaris fails - before that certificate is what gets said.
 */
async function alreadyListed(origin: string, verdict: ServerVerdict): Promise<string | null> {
    const untrusted = verdict.kind === "unreachable" && isCertificateError(netErrorCode(verdict.cause ?? ""));
    if (verdict.kind !== "polaris" && !untrusted) return null;
    const saved = savedServers();
    if (saved.some((server) => server.origin === origin)) return null;
    const same = await sameInstanceAs(origin, saved, untrusted).catch(() => null);
    const row = same ? listServers(saved, current).find((server) => server.origin === same) : undefined;
    return row ? sameInstanceWords(row) : null;
}

/** Whether an address is a Polaris that can be opened now, and if not, why. */
async function probe(origin: string): Promise<string | null> {
    const verdict = await serverCheck.check(origin);
    const listed = await alreadyListed(origin, verdict);
    if (listed) return listed;
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
        const listed = await alreadyListed(parsed.data, verdict);
        if (controller.signal.aborted) return { ok: false, message: null };
        if (listed) return { ok: false, message: listed };
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
    const origin = server();
    if (!contents || !origin || kindOf(contents) !== "polaris") return;
    const history = contents.navigationHistory;
    const urls = history.getAllEntries().map((entry) => entry.url);
    const index = backIndex(urls, history.getActiveIndex(), origin);
    if (index !== null) history.goToIndex(index);
}

async function connectSubmit(raw: unknown, typedName = ""): Promise<Outcome> {
    const parsed = serverAddressSchema.safeParse(typeof raw === "string" ? raw : "");
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "That is not an address." };
    const name = normalizeServerName(typedName);
    if (name && name.length > SERVER_NAME_MAX) return { ok: false, error: `Use at most ${SERVER_NAME_MAX} characters.` };
    const origin = parsed.data;
    const problem = await probe(origin);
    if (problem) return { ok: false, error: problem };

    const changed = origin !== current;
    setServerAddress(origin);
    if (name) setSavedServers(renameServer(savedServers(), origin, name));
    if (changed) leaveServer();
    dropAlternate();
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
        return Promise.resolve({ ok: false, error: "That host is not on the list any more." });
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
        dropAlternate();
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

/** Whether this run uses the graphics card, as read when it started. */
let accelerated = true;

function start(): void {
    // Windows reports a window behind a full-screen game as gone, and Chromium then
    // starves it, along with the call inside.
    app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    // Electron takes this only before the app is ready, so a change waits for a restart.
    accelerated = settings.hardwareAcceleration();
    if (!accelerated) app.disableHardwareAcceleration();
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
            callback(allowPermission(permission, details.requestingUrl, server()));
        });
        session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
            allowPermission(permission, requestingOrigin, server())
        );

        registerIpc({
            server,
            showPolaris,
            runningGame: () => games.running(),
            isReporter: (sender) => Boolean(main && !main.isDestroyed() && main.webContents === sender),
            setCustomGames: (list) => games.setCustomGames(list),
            connectState: () => ({ address: current, error: loadError, servers: servers() }),
            preferences: () => {
                const hardwareAcceleration = settings.hardwareAcceleration();
                return {
                    openAtLogin: settings.openAtLogin(),
                    hardwareAcceleration,
                    restartPending: hardwareAcceleration !== accelerated,
                    version: app.getVersion()
                };
            },
            setOpenAtLogin: (open) => {
                if (!setOpenAtLogin(open)) return false;
                settings.rememberOpenAtLogin(open);
                return true;
            },
            setHardwareAcceleration: (on) => {
                settings.rememberHardwareAcceleration(on);
                return true;
            },
            relaunch: () => {
                if (pushRunning()) return { ok: false, error: "A push is still running. Restart once it finishes." };
                const appImage = process.env.APPIMAGE;
                app.relaunch(appImage ? { execPath: appImage, args: process.argv.slice(1) } : undefined);
                app.exit(0);
                return { ok: true };
            },
            connectSubmit,
            connectCheck,
            switchServer,
            nameServer,
            removeServer,
            closeConnect,
            openServers: openConnect,
            updates,
            checkUpdates: () =>
                updateWatch?.checkNow() ??
                Promise.resolve({ kind: "failed", reason: "Polaris is still starting. Try again in a moment." } as const),
            openUpdatePage: () => {
                if (!menuUpdate) return false;
                menuUpdate.open();
                return true;
            }
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
            // In the dashboard's own dialog when there is a Polaris to show it,
            // in a window of its own when there is not.
            installOnTv: () => (current && !loadError ? showPolaris("/account/downloads?tv=install") : openTvInstall()),
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
        const first = (updateWatch = watchForUpdates((update) => {
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
        }));

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
