/**
 * The app's windows, and the rules each kind lives by.
 *
 * Two kinds of page, never mixed in one window:
 *
 * - **Polaris windows** load the configured instance and carry the dashboard's
 *   bridge. Their main frame may only ever be on that origin (see
 *   `navigation`); a link anywhere else opens in the system browser, and a new
 *   window the dashboard opens on its own origin is another Polaris window
 *   under the same rules.
 * - **Local windows** show a page this app ships - the address form, the key
 *   form, a push - with the local bridge. They navigate nowhere.
 *
 * Every window is sandboxed, isolated, without Node, and without `<webview>`.
 */

import { join } from "node:path";
import { classifyNavigation } from "./navigation";
import { VERSION_ARGUMENT } from "@/shared/bridge";
import {
    app,
    BrowserWindow,
    nativeTheme,
    shell,
    type BrowserWindowConstructorOptions,
    type WebContents,
    type WebPreferences
} from "electron";

export type WindowKind = "polaris" | "connect" | "api-key" | "push";

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
 * anywhere. Read per event, so a changed server applies at once.
 */
function contain(contents: WebContents, server: () => string | null): void {
    const guard = (event: { preventDefault: () => void; }, url: string) => {
        const origin = server();
        const verdict = origin ? classifyNavigation(url, origin) : "block";
        if (verdict === "allow") return;
        event.preventDefault();
        if (verdict === "external") void shell.openExternal(url);
    };
    contents.on("will-navigate", guard);
    contents.on("will-redirect", guard);
    contents.setWindowOpenHandler(({ url }) => {
        const origin = server();
        const verdict = origin ? classifyNavigation(url, origin) : "block";
        if (verdict === "allow") {
            return {
                action: "allow",
                overrideBrowserWindowOptions: windowOptions({
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

/** A window showing one of this app's own pages. */
export function openLocalWindow(
    kind: Exclude<WindowKind, "polaris">,
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
