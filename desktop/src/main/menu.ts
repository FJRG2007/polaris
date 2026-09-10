/**
 * The application menu: File (Change server, Back, Reload, Forget API key),
 * Edit, View, Window and Help - which also offers a newer version once one is
 * out.
 *
 * Installed on every platform. macOS draws it in the menu bar; Windows and Linux
 * draw it in the window. Electron's roles bring the right labels, shortcuts and
 * translations - Edit in particular is what makes Cmd+C and Cmd+V reach a text
 * field on macOS at all.
 */

import { app, Menu, type MenuItemConstructorOptions } from "electron";

export interface MenuActions {
    readonly changeServer: () => void;
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
}

export function installMenu(actions: MenuActions, update?: MenuUpdate): void {
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
                { label: "Change server...", click: actions.changeServer },
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
                ...(update
                    ? ([
                          { label: `Download Polaris ${update.version}...`, click: update.open },
                          { type: "separator" }
                      ] satisfies MenuItemConstructorOptions[])
                    : []),
                { label: "Open this Polaris in the browser", click: actions.openInBrowser },
                ...(isMac ? [] : ([{ type: "separator" }, { role: "about" }] satisfies MenuItemConstructorOptions[]))
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
