import { defineConfig } from "wxt";

/**
 * What the extension asks the browser for, and deliberately does not.
 *
 * **No host permission is declared up front.** Every Polaris is on somebody
 * else's domain, so there is no origin to name at build time - and an extension
 * that shipped `*://*//*` in `host_permissions` would be asking to read every
 * page on the web before it has been told which server it belongs to. The origin
 * is requested at runtime, once, for the address the person typed
 * (`src/lib/server.ts`), which is also what makes the vault calls exempt from
 * CORS: nothing on the Polaris side answers a preflight.
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
        permissions: ["storage", "activeTab", "scripting", "alarms"],
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
        // The same request, under the name each manifest version has for it.
        // `optional_host_permissions` does not exist in version 2 and WXT does not
        // translate it, so it was simply absent from the Firefox build - and an
        // origin that is in no optional list is one `permissions.request` refuses,
        // which left the extension unable to reach any server at all there.
        ...(manifestVersion === 3
            ? { optional_host_permissions: ["https://*/*", "http://*/*"] }
            : { optional_permissions: ["https://*/*", "http://*/*"] }),
        ...(browser === "firefox"
            ? { browser_specific_settings: { gecko: { id: "vault@polaris.local" } } }
            : {})
    })
});
