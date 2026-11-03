/**
 * The one answer to "which Polaris is this person looking at", and the words a
 * message picks by it.
 */

import { describe, expect, it } from "vitest";
import {
    clientFacts,
    clientFromUserAgent,
    clientMessageValues,
    createTranslator
} from "../src/index.js";

const CHROME =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const DESKTOP =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Polaris/0.1.11 Chrome/131.0.0.0 Electron/38.0.0 Safari/537.36";
/** Another Electron app. Its user-agent is not the desktop app's. */
const OTHER_ELECTRON =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.0 Chrome/131.0.0.0 Electron/33.0.0 Safari/537.36";

describe("clientFromUserAgent", () => {
    it("knows the desktop app by its name and Electron together", () => {
        expect(clientFromUserAgent(DESKTOP)).toBe("desktop");
        expect(clientFromUserAgent(DESKTOP.replace("Polaris/", "polaris-desktop/"))).toBe(
            "desktop"
        );
    });

    it("reads everything else as a browser", () => {
        expect(clientFromUserAgent(CHROME)).toBe("browser");
        expect(clientFromUserAgent(OTHER_ELECTRON)).toBe("browser");
        expect(clientFromUserAgent(undefined)).toBe("browser");
        expect(clientFromUserAgent("")).toBe("browser");
    });
});

describe("clientFacts", () => {
    it("gives the desktop app system notices and an app icon", () => {
        expect(clientFacts("desktop")).toEqual({
            host: "app",
            notices: "system",
            badge: "app-icon"
        });
    });

    it("leaves an installed web app's notices to the browser", () => {
        expect(clientFacts("installed").notices).toBe("browser-permission");
        expect(clientFacts("installed").host).toBe("app");
    });
});

describe("messages worded by client", () => {
    const catalog = {
        blocked: "{surface, select, app {This app} other {This browser}} is blocking them.",
        named: "{clientKind, select, desktop {Desktop} other {Elsewhere}}",
        plain: "No choice here."
    };

    it("words a message for the app without the caller passing anything", () => {
        const t = createTranslator("en-US", catalog, { client: "desktop" });
        expect(t("blocked")).toBe("This app is blocking them.");
        expect(t("named")).toBe("Desktop");
    });

    it("words it for a browser when no client is given, instead of failing", () => {
        const t = createTranslator("en-US", catalog);
        expect(t("blocked")).toBe("This browser is blocking them.");
        expect(t("plain")).toBe("No choice here.");
    });

    it("lets a caller's own value win over where the page is drawn", () => {
        const t = createTranslator("en-US", catalog, { client: "desktop" });
        expect(t("blocked", { surface: "browser" })).toBe("This browser is blocking them.");
    });

    it("hands the same two values to every message", () => {
        expect(clientMessageValues("installed")).toEqual({
            clientKind: "installed",
            surface: "app"
        });
    });
});
