/**
 * The app's windows, and the rules each kind lives by.
 *
 * Two kinds of page, never mixed in one window:
 *
 * - **Polaris windows** load the configured instance and carry the dashboard's
 *   bridge. Their main frame stays on that origin, but for a provider's round
 *   trip the instance starts (see `navigation`); a link anywhere else opens in
 *   the system browser, and a new
 *   window the dashboard opens on its own origin is another Polaris window
 *   under the same rules.
 * - **Local windows** show a page this app ships - the address form, the key
 *   form, a push - with the local bridge. They navigate nowhere. The settings
 *   can also be a **sheet**: the same page laid over a Polaris window.
 *
 * Every window is sandboxed, isolated, without Node, and without `<webview>`.
 */

import { join } from "node:path";
import { release } from "node:os";
import { textSize } from "./settings";
import { TEXT_SIZE_ARGUMENT, VERSION_ARGUMENT } from "@/shared/bridge";
import { defaultTitleBarColors, foreignPageCss, overlayHeight } from "@/shared/title-bar";
import { classifyNavigation, isServerUrl, mainFrameStep } from "./navigation";
import {
    app,
    BrowserWindow,
    WebContentsView,
    nativeTheme,
    shell,
    type BrowserWindowConstructorOptions,
    type WebContents,
    type WebPreferences
} from "electron";

export type WindowKind = "polaris" | "connect" | "api-key" | "push" | "tv" | "overlay" | "voice-widget" | "updating";

const kinds = new Map<number, WindowKind>();

/** Which kind of window a request came from, or null for anything else. */
export function kindOf(sender: WebContents): WindowKind | null {
    return kinds.get(sender.id) ?? null;
}

/** The ground a window opens on before its page paints - the dashboard's own
 *  background in each theme, so opening is not a white flash. */
function ground(): string {
    return nativeTheme.shouldUseDarkColors ? "#0b0c0e" : "#f6f6f9";
}

function preferences(preload: string, extra: WebPreferences = {}): WebPreferences {
    return {
        preload: join(__dirname, "..", "preload", preload),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        ...extra
    };
}

/**
 * No title bar on a Polaris window on Windows and Linux: the page runs to the top
 * edge, and the system's own minimize, maximize and close buttons are drawn over
 * its header (the Window Controls Overlay), the way Discord and Teams look. The
 * page leaves room for them and is dragged by its header - see `app-titlebar`
 * in the dashboard - and the preload paints them in the header's colours
 * (`titleBarColors`). The system's buttons rather than drawn ones, because they
 * keep Windows' snap layouts on hover. macOS keeps its own title bar.
 */
function titleBar(): BrowserWindowConstructorOptions {
    if (process.platform === "darwin") return {};
    const colors = defaultTitleBarColors(nativeTheme.shouldUseDarkColors);
    return {
        titleBarStyle: "hidden",
        titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: overlayHeight(1) }
    };
}

/** A fixed window whose page is all there is: no title bar, the system's close
 *  button over the page's own ground. */
function splashChrome(): BrowserWindowConstructorOptions {
    const fixed = { resizable: false, maximizable: false, fullscreenable: false };
    if (process.platform === "darwin") return { ...fixed, titleBarStyle: "hiddenInset" };
    return {
        ...fixed,
        titleBarStyle: "hidden",
        titleBarOverlay: {
            color: ground(),
            symbolColor: defaultTitleBarColors(nativeTheme.shouldUseDarkColors).symbol,
            height: 32
        }
    };
}

/** The app's own pages, opened at the account's text size (`preload/local.ts`). */
function localPreferences(): WebPreferences {
    return preferences("local.js", { additionalArguments: [`${TEXT_SIZE_ARGUMENT}${textSize()}`] });
}

function polarisPreferences(): WebPreferences {
    // A call keeps running behind a full-screen game, which is when a window is hidden.
    return preferences("app.js", { backgroundThrottling: false, additionalArguments: [`${VERSION_ARGUMENT}${app.getVersion()}`] });
}

function register(contents: WebContents, kind: WindowKind): void {
    const id = contents.id;
    kinds.set(id, kind);
    contents.once("destroyed", () => kinds.delete(id));
    contents.on("will-attach-webview", (event) => event.preventDefault());
}

function windowOptions(options: BrowserWindowConstructorOptions): BrowserWindowConstructorOptions {
    return {
        backgroundColor: ground(),
        show: false,
        autoHideMenuBar: false,
        // Windows and macOS take the icon from the executable; Linux from here.
        ...(process.platform === "linux" ? { icon: join(__dirname, "..", "icon.png") } : {}),
        ...options
    };
}

/**
 * Hold a Polaris window to its origin: the main frame stays on the server,
 * anything else on the web goes to the system browser, and nothing else goes
 * anywhere - except during a provider's round trip the server started (see
 * `navigation`). Frames inside the page are the page's business. Read per
 * event, so a changed server applies at once.
 */
function contain(contents: WebContents, server: () => string | null): void {
    let trip = false;
    const guard = (event: { preventDefault: () => void; readonly url: string; readonly isMainFrame: boolean; }) => {
        if (!event.isMainFrame) return;
        const origin = server();
        const step = origin ? mainFrameStep(event.url, origin, trip) : null;
        trip = step?.trip ?? false;
        if (step?.verdict === "allow") return;
        event.preventDefault();
        if (step?.verdict === "external") void shell.openExternal(event.url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    // A provider's page has no header to sit the window buttons in or to drag
    // the window by, and no preload that may report its colours.
    contents.on("dom-ready", () => {
        const origin = server();
        if (process.platform === "darwin" || !origin || isServerUrl(contents.getURL(), origin)) return;
        const colors = defaultTitleBarColors(nativeTheme.shouldUseDarkColors);
        BrowserWindow.fromWebContents(contents)?.setTitleBarOverlay({
            color: colors.background,
            symbolColor: colors.symbol,
            height: overlayHeight(contents.getZoomFactor())
        });
        void contents.insertCSS(foreignPageCss(colors.background));
    });
    contents.on("did-navigate", (_event, url) => {
        const origin = server();
        if (!trip || !origin || !isServerUrl(url, origin)) return;
        trip = false;
        contents.navigationHistory.clear();
    });
    contents.setWindowOpenHandler(({ url }) => {
        const origin = server();
        const verdict = origin ? classifyNavigation(url, origin) : "block";
        if (verdict === "allow") {
            return {
                action: "allow",
                overrideBrowserWindowOptions: windowOptions({
                    ...titleBar(),
                    width: 1100,
                    height: 760,
                    show: true,
                    webPreferences: polarisPreferences()
                })
            };
        }
        if (verdict === "external") void shell.openExternal(url);
        return { action: "deny" };
    });
    contents.on("did-create-window", (child) => {
        register(child.webContents, "polaris");
        contain(child.webContents, server);
    });
}

/** A window on the Polaris at `url`. */
export function openPolarisWindow(
    url: string,
    server: () => string | null,
    options: {
        readonly title?: string;
        readonly width?: number;
        readonly height?: number;
        readonly x?: number;
        readonly y?: number;
        readonly maximized?: boolean;
        /** Made but kept off screen until somebody asks for it (the tray). */
        readonly hidden?: boolean;
    } = {}
): BrowserWindow {
    const window = new BrowserWindow(
        windowOptions({
            ...titleBar(),
            title: options.title ?? "Polaris",
            width: options.width ?? 1280,
            height: options.height ?? 820,
            ...(options.x === undefined ? {} : { x: options.x, y: options.y }),
            minWidth: 360,
            minHeight: 480,
            webPreferences: polarisPreferences()
        })
    );
    register(window.webContents, "polaris");
    contain(window.webContents, server);
    // The page's own <title> is kept for the main window; a window opened for one
    // job keeps the name it was given, so two log windows can be told apart.
    if (options.title) window.on("page-title-updated", (event) => event.preventDefault());
    const { x, y, width, height, maximized, hidden } = options;
    window.once("ready-to-show", () => {
        // Asked again now it exists: a window made on a monitor of another scale
        // takes its size from the one it was made on. It is not on screen yet.
        if (x !== undefined && y !== undefined && width && height) {
            window.setBounds({ x, y, width, height });
        }
        if (hidden) {
            // Maximizing shows a window, so it waits for the first time it is.
            if (maximized) window.once("show", () => window.maximize());
            return;
        }
        if (maximized) window.maximize();
        window.show();
    });
    void window.loadURL(url);
    return window;
}

/** The Windows build number, `10.0.<build>`; 0 when it cannot be read. */
function windowsBuild(): number {
    return Number(release().split(".")[2]) || 0;
}

/**
 * The see-through window strokes are drawn in, over a whole display.
 *
 * It takes no clicks and no focus, so the person sharing goes on using their
 * screen underneath it, and it is kept out of screen captures where the system
 * allows that (Windows 10 2004 and later, macOS), so the share does not carry
 * the strokes a second time behind the ones the room already draws.
 */
export function openOverlayWindow(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }): BrowserWindow {
    const window = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        webPreferences: localPreferences()
    });
    register(window.webContents, "overlay");
    window.setIgnoreMouseEvents(true);
    // Before Windows 10 2004 a protected window is captured black rather than
    // left out, which would black out the whole share.
    if (process.platform !== "win32" || windowsBuild() >= 19041) window.setContentProtection(true);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadFile(join(__dirname, "..", "renderer", "overlay.html"));
    return window;
}

/**
 * The voice widget's window: small, see-through, over everything - a game
 * running windowed or borderless included - and never in the taskbar. It takes
 * no focus, so a press on it does not take the keyboard from the game, and
 * clicks go through it until it is unlocked (`voice-widget`). Kept out of
 * screen captures where the system allows it, like the drawing overlay, so a
 * share does not show it.
 */
export function openVoiceWidgetWindow(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }): BrowserWindow {
    const window = new BrowserWindow({
        ...bounds,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        webPreferences: localPreferences()
    });
    register(window.webContents, "voice-widget");
    window.setIgnoreMouseEvents(true, { forward: true });
    if (process.platform !== "win32" || windowsBuild() >= 19041) window.setContentProtection(true);
    window.setAlwaysOnTop(true, "screen-saver");
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void window.loadFile(join(__dirname, "..", "renderer", "voice-widget.html"));
    return window;
}

/** A local page laid over a window as a sheet rather than given a window of its own. */
export interface LocalSheet {
    focus(): void;
    close(): void;
    isDestroyed(): boolean;
}

/**
 * The settings over the Polaris window they belong to: the window dims and the
 * page sits on it, the way an app's own settings do, instead of a second window
 * appearing beside it. Same page, same bridge and the same rules as a local
 * window; the page is told with `?sheet` and draws itself as a card. It closes
 * with its window, and says so through `onClosed`.
 */
export function openLocalSheet(parent: BrowserWindow, kind: "connect", onClosed: () => void): LocalSheet {
    const view = new WebContentsView({ webPreferences: localPreferences() });
    view.setBackgroundColor("#00000000");
    const contents = view.webContents;
    register(contents, kind);
    contents.on("will-navigate", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));

    const fit = () => {
        if (parent.isDestroyed()) return;
        const [width = 0, height = 0] = parent.getContentSize();
        view.setBounds({ x: 0, y: 0, width, height });
    };
    const RESIZES = ["resize", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const;
    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        for (const event of RESIZES) parent.off(event as "resize", fit);
        if (!parent.isDestroyed()) {
            parent.contentView.removeChildView(view);
            parent.webContents.focus();
        }
        if (!contents.isDestroyed()) contents.close();
        onClosed();
    };

    fit();
    for (const event of RESIZES) parent.on(event as "resize", fit);
    parent.once("closed", close);
    parent.contentView.addChildView(view);
    contents.once("did-finish-load", () => contents.focus());
    void contents.loadFile(join(__dirname, "..", "renderer", `${kind}.html`), { query: { sheet: "1" } });
    return { focus: () => contents.focus(), close, isDestroyed: () => closed };
}

/** A window showing one of this app's own pages. */
export function openLocalWindow(
    kind: Exclude<WindowKind, "polaris" | "overlay">,
    options: { readonly title: string; readonly width: number; readonly height: number; readonly parent?: BrowserWindow; }
): BrowserWindow {
    const window = new BrowserWindow(
        windowOptions({
            title: options.title,
            width: options.width,
            height: options.height,
            minWidth: 360,
            minHeight: 320,
            parent: options.parent,
            modal: false,
            webPreferences: localPreferences(),
            ...(kind === "updating" ? splashChrome() : {})
        })
    );
    register(window.webContents, kind);
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.on("page-title-updated", (event) => event.preventDefault());
    window.once("ready-to-show", () => window.show());
    void window.loadFile(join(__dirname, "..", "renderer", `${kind}.html`));
    return window;
}
