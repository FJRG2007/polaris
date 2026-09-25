import { defineConfig } from "wxt";

/**
 * What the extension asks the browser for, and deliberately does not.
 *
 * **Every web page, on Chromium.** The list of logins and codes under a login
 * box has to be there on whatever site somebody opens, the way a password
 * manager's is - and a script can only be put inside a page the extension has
 * access to. Asked for one site at a time, from a switch in the popup, it was a
 * feature nobody found: installed, it showed up nowhere. So Chromium's build
 * declares every https and http page like every password manager does, the
 * browser says so once at install, and the popup's "Only some sites" narrows it
 * back for anybody who wants that. The Polaris server's own origin is covered by
 * the same grant, which is also what makes the vault calls exempt from CORS.
 *
 * Firefox's build keeps asking at runtime (`src/lib/server.ts`): manifest v2
 * cannot register a script at runtime at all, so a standing grant would buy
 * nothing there.
 *
 * `activeTab` and `scripting` are what filling a form needs: the tab in front of
 * somebody, at the moment they ask for it, rather than a standing hold on every
 * tab.
 *
 * The popup and the background are one build for both browsers. WXT writes MV3
 * for Chromium and converts to what Firefox takes, so the only per-browser thing
 * here is the Firefox add-on id, which has to be stable for an unsigned build to
 * keep its storage between reloads.
 */
export default defineConfig({
    srcDir: "src",
    modules: ["@wxt-dev/module-react"],
    /**
     * One name per browser, with no version in it.
     *
     * The package is loaded by hand by most of the people who have it, and an
     * unpacked extension is refreshed from the folder it was loaded from - so a
     * filename that changes every release means a new folder every release, and
     * "Load unpacked" again instead of the refresh button. A constant name lets
     * the same download replace the same file in the same place, which is the
     * whole of what updating one of these is.
     *
     * `publicDir` is relative to the project root rather than to `srcDir`, so the
     * icon below lives at `public/icon/128.png` and is copied out as-is.
     */
    zip: {
        artifactTemplate: "polaris-extension-{{browser}}.zip",
        sourcesTemplate: "polaris-extension-sources.zip"
    },
    manifest: ({ browser, manifestVersion }) => ({
        name: "Polaris",
        // Polaris, not "Polaris's vault". The logins are what it does today and
        // the only thing described here, but the extension is the product's
        // window in the toolbar rather than one feature of it - and a name that
        // says "vault" is one that has to be argued with every time it grows.
        description: "Polaris in your toolbar.",
        // Polaris's own mark. Without this the browser draws the grey puzzle
        // piece, which is what every extension nobody has looked at looks like.
        // One file at every size: the browsers pick the nearest and scale, and a
        // 128 mark scaled down reads better than four separate crops drifting
        // apart. Sizes still have to be declared even when they share a file.
        icons: {
            16: "icon/128.png",
            32: "icon/128.png",
            48: "icon/128.png",
            128: "icon/128.png"
        },
        // `alarms` is what makes the idle lock real rather than something that only
        // happens the next time somebody opens the popup. Under manifest v3 the
        // worker is recycled and takes the key with it; a manifest v2 background
        // page is persistent and never is, so without a timer of its own an
        // unlocked vault on Firefox would stay unlocked until the browser closed.
        // `contextMenus` is Polaris's own entries in the right-click menu on a
        // box you can type into. It carries no install warning.
        permissions: ["storage", "activeTab", "scripting", "alarms", "contextMenus"],
        // Filling from the keyboard, without going through the toolbar. The
        // browser owns the binding - somebody can change or remove it in its own
        // shortcuts screen - and it does nothing at all while the vault is
        // locked, because the alternative is a shortcut that silently opens a
        // password prompt somebody did not ask for.
        commands: {
            "fill-login": {
                suggested_key: { default: "Ctrl+Shift+L", mac: "Command+Shift+L" },
                description: "Fill the login for this page"
            }
        },
        // Every web page on version 3 (see the top of this file), and the
        // runtime request on version 2, under the name version 2 has for it:
        // `optional_host_permissions` does not exist there and WXT does not
        // translate it, and an origin in no optional list is one
        // `permissions.request` refuses - no server could be reached at all.
        ...(manifestVersion === 3
            ? {
                  host_permissions: ["https://*/*", "http://*/*"],
                  /**
                   * WebAssembly, which a vault on Argon2id is opened through.
                   *
                   * Manifest v3 blocks it outright unless the manifest asks: the
                   * default policy is `script-src 'self'`, and under it
                   * `WebAssembly.compile` throws "Wasm code generation disallowed
                   * by embedder" the moment a master password is typed. What that
                   * reached the screen as was the vault refusing a password that
                   * opens it perfectly well on the dashboard - an account locked
                   * out of the extension with nothing to read but its own
                   * refusal, for a setting somebody chose on another screen.
                   *
                   * `wasm-unsafe-eval` is the narrow form: it permits compiling
                   * WebAssembly and nothing else. `eval` and remote script stay
                   * refused, which is the part that matters in a password
                   * manager. Manifest v2 (Firefox) allows WebAssembly under its
                   * own default policy, so its build is left alone.
                   */
                  content_security_policy: {
                      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
                  }
              }
            : { optional_permissions: ["https://*/*", "http://*/*"] }),
        ...(browser === "firefox"
            ? { browser_specific_settings: { gecko: { id: "vault@polaris.local" } } }
            : {})
    })
});
