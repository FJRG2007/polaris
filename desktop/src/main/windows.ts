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
 *   form, a push - with the local bridge. They navigate nowhere.
 *
 * Every window is sandboxed, isolated, without Node, and without `<webview>`.
 */

import { join } from "node:path";
import { release } from "node:os";
import { VERSION_ARGUMENT } from "@/shared/bridge";
import { defaultTitleBarColors, foreignPageCss, overlayHeight, TITLE_BAR_HEIGHT } from "@/shared/title-bar";
import { classifyNavigation, isServerUrl, mainFrameStep } from "./navigation";
import {
    app,
    BrowserWindow,
    nativeTheme,
    shell,
    type BrowserWindowConstructorOptions,
    type WebContents,
    type WebPreferences
} from "electron";

export type WindowKind = "polaris" | "connect" | "api-key" | "push" | "overlay";

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
        titleBarOverlay: { color: colors.background, symbolColor: colors.symbol, height: TITLE_BAR_HEIGHT }
    };
}

function polarisPreferences(): WebPreferences {
    return preferences("app.js", { additionalArguments: [`${VERSION_ARGUMENT}${app.getVersion()}`] });
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
    options: { readonly title?: string; readonly width?: number; readonly height?: number; } = {}
): BrowserWindow {
    const window = new BrowserWindow(
        windowOptions({
            ...titleBar(),
            title: options.title ?? "Polaris",
            width: options.width ?? 1280,
            height: options.height ?? 820,
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
    window.once("ready-to-show", () => window.show());
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
        webPreferences: preferences("local.js")
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
            webPreferences: preferences("local.js")
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
