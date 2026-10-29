/**
 * The application menu: File (Servers, Switch to, Back, Reload, Forget API key),
 * Edit, View, Window and Help - which also offers a newer version once one is
 * out.
 *
 * Installed on every platform, and drawn only on macOS, in the menu bar. On
 * Windows and Linux the windows hide it (`hideMenuBars`): a File / Edit / View
 * strip across a chat app is not what anybody expects there, and the menu stays
 * installed only so its shortcuts - reload, zoom, back - keep working. What it
 * holds that is the app's own goes in the tray icon instead (`appItems`).
 * Electron's roles bring the right labels, shortcuts and translations - Edit in
 * particular is what makes Cmd+C and Cmd+V reach a text field on macOS at all.
 */

import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { describeServer, type ServerRow } from "@/shared/servers";

export interface MenuActions {
    readonly changeServer: () => void;
    readonly switchServer: (origin: string) => void;
    readonly back: () => void;
    readonly reload: () => void;
    readonly forgetApiKey: () => void;
    readonly openApiKeys: () => void;
    readonly openInBrowser: () => void;
}

const isMac = process.platform === "darwin";

/** A newer version to offer, and how to get it. */
export interface MenuUpdate {
    readonly version: string;
    readonly open: () => void;
    /** Set once it is installed: restart into it instead of downloading. */
    readonly restart?: () => void;
}

/** One line per server, the one in use ticked. Only worth a submenu once there
 *  is somewhere else to go. */
function switchTo(actions: MenuActions, servers: readonly ServerRow[]): MenuItemConstructorOptions[] {
    return (
        servers.length > 1
            ? [
                  {
                      label: "Switch to",
                      submenu: servers.map((server) => ({
                          label: describeServer(server),
                          sublabel: server.name ? server.host : undefined,
                          type: "radio" as const,
                          checked: server.active,
                          click: () => {
                              if (!server.active) actions.switchServer(server.origin);
                          }
                      }))
                  }
              ]
            : []
    );
}

/** The newer version on offer, as a line to act on. */
function updateItems(update?: MenuUpdate): MenuItemConstructorOptions[] {
    if (!update) return [];
    return [
        update.restart
            ? { label: `Restart to update to Polaris ${update.version}`, click: update.restart }
            : { label: `Download Polaris ${update.version}...`, click: update.open },
        { type: "separator" }
    ];
}

/**
 * What the app itself offers, for the tray icon where the window draws no menu:
 * the servers, the saved API key, an update waiting, and the browser.
 */
export function appItems(
    actions: MenuActions,
    update?: MenuUpdate,
    servers: readonly ServerRow[] = []
): MenuItemConstructorOptions[] {
    return [
        ...updateItems(update),
        { label: "Servers...", click: actions.changeServer },
        ...switchTo(actions, servers),
        { type: "separator" },
        { label: "API keys", click: actions.openApiKeys },
        { label: "Forget the saved API key", click: actions.forgetApiKey },
        { label: "Open this Polaris in the browser", click: actions.openInBrowser }
    ];
}

/** Take the menu bar off a window on Windows and Linux; see the file comment. */
export function hideMenuBar(window: BrowserWindow): void {
    if (!isMac) window.setMenuBarVisibility(false);
}

export function installMenu(actions: MenuActions, update?: MenuUpdate, servers: readonly ServerRow[] = []): void {
    const template: MenuItemConstructorOptions[] = [
        ...(isMac
            ? ([
                  {
                      label: app.name,
                      submenu: [
                          { role: "about" },
                          { type: "separator" },
                          { role: "services" },
                          { type: "separator" },
                          { role: "hide" },
                          { role: "hideOthers" },
                          { role: "unhide" },
                          { type: "separator" },
                          { role: "quit" }
                      ]
                  }
              ] satisfies MenuItemConstructorOptions[])
            : []),
        {
            label: "File",
            submenu: [
                { label: "Servers...", click: actions.changeServer },
                ...switchTo(actions, servers),
                { label: "Back", accelerator: isMac ? "Cmd+[" : "Alt+Left", click: actions.back },
                { label: "Reload", accelerator: "CmdOrCtrl+R", click: actions.reload },
                { type: "separator" },
                { label: "API keys", click: actions.openApiKeys },
                { label: "Forget the saved API key", click: actions.forgetApiKey },
                { type: "separator" },
                isMac ? { role: "close" } : { role: "quit" }
            ]
        },
        {
            label: "Edit",
            submenu: [
                { role: "undo" },
                { role: "redo" },
                { type: "separator" },
                { role: "cut" },
                { role: "copy" },
                { role: "paste" },
                ...(isMac
                    ? ([{ role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" }] satisfies MenuItemConstructorOptions[])
                    : ([{ role: "delete" }, { type: "separator" }, { role: "selectAll" }] satisfies MenuItemConstructorOptions[]))
            ]
        },
        {
            label: "View",
            submenu: [
                { role: "forceReload" },
                { role: "toggleDevTools" },
                { type: "separator" },
                { role: "resetZoom" },
                { role: "zoomIn" },
                { role: "zoomOut" },
                { type: "separator" },
                { role: "togglefullscreen" }
            ]
        },
        {
            label: "Window",
            submenu: [
                { role: "minimize" },
                { role: "zoom" },
                ...(isMac
                    ? ([{ type: "separator" }, { role: "front" }] satisfies MenuItemConstructorOptions[])
                    : ([{ role: "close" }] satisfies MenuItemConstructorOptions[]))
            ]
        },
        {
            role: "help",
            submenu: [
                ...updateItems(update),
                { label: "Open this Polaris in the browser", click: actions.openInBrowser },
                ...(isMac ? [] : ([{ type: "separator" }, { role: "about" }] satisfies MenuItemConstructorOptions[]))
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
