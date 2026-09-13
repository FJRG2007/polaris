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
    manifest: ({ browser }) => ({
        name: "Polaris",
        description: "Your Polaris vault, in the toolbar.",
        permissions: ["storage", "activeTab", "scripting"],
        optional_host_permissions: ["https://*/*", "http://*/*"],
        ...(browser === "firefox"
            ? { browser_specific_settings: { gecko: { id: "vault@polaris.local" } } }
            : {})
    })
});
