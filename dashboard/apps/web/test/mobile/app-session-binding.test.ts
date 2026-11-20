/**
 * The phone app's own connections - the notification service, the view-once
 * screen - carry the page's User-Agent but none of its client hints. The
 * session the page opened must still recognise them: a mismatch revokes it as
 * stolen.
 */

import { describe, expect, it } from "vitest";
import { bindingBreach, describeClient } from "@polaris/core";

const PAGE_AGENT =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.102 Mobile Safari/537.36 PolarisMobile/0.1.2 (Android)";
const PAGE_BRANDS = '"Chromium";v="130", "Android WebView";v="130", "Not?A_Brand";v="99"';
const PAGE_PLATFORM = '"Android"';

describe("the app's own connections and the page's session", () => {
    it("are the same client, from the same address or another", () => {
        const page = describeClient(PAGE_AGENT, PAGE_BRANDS, PAGE_PLATFORM);
        const claimed = describeClient(PAGE_AGENT, null, null);
        const service = describeClient(PAGE_AGENT, null, null);
        for (const ip of ["198.51.100.7", "203.0.113.9"]) {
            expect(
                bindingBreach(
                    { bindClient: true, pinScope: "off", pinThisSession: null },
                    {
                        os: page.os,
                        browser: page.browser,
                        claimedOs: claimed.os,
                        claimedBrowser: claimed.browser,
                        brandHinted: true,
                        platformHinted: true,
                        ip: "198.51.100.7",
                        handheld: true
                    },
                    {
                        os: service.os,
                        browser: service.browser,
                        claimedOs: service.os,
                        claimedBrowser: service.browser,
                        brandHinted: false,
                        platformHinted: false,
                        ip
                    }
                )
            ).toBeNull();
        }
    });

    it("still knows the app when a request comes without its marker", () => {
        // A service worker's fetch carries the WebView's own user-agent, without
        // PolarisMobile/: seen on 2026-11-20, it revoked the owner's own session.
        const bare = PAGE_AGENT.replace(/ PolarisMobile\/[^ ]+ \(Android\)/, "");
        const page = describeClient(PAGE_AGENT, PAGE_BRANDS, PAGE_PLATFORM);
        expect(page.browser).toBe("Polaris Mobile");
        for (const [brands, platform] of [
            [PAGE_BRANDS, PAGE_PLATFORM],
            [null, null]
        ] as const) {
            const worker = describeClient(bare, brands, platform);
            expect(worker.browser).toBe(brands ? "Android WebView" : "Chrome");
            expect(
                bindingBreach(
                    { bindClient: true, pinScope: "off", pinThisSession: null },
                    {
                        os: page.os,
                        browser: page.browser,
                        claimedOs: page.os,
                        claimedBrowser: page.browser,
                        brandHinted: true,
                        platformHinted: true,
                        ip: "198.51.100.7",
                        handheld: true
                    },
                    {
                        os: worker.os,
                        browser: worker.browser,
                        claimedOs: worker.os,
                        claimedBrowser: worker.browser,
                        brandHinted: brands !== null,
                        platformHinted: platform !== null,
                        ip: "203.0.113.9"
                    }
                )
            ).toBeNull();
        }
    });

    it("still refuses the app's cookie in a desktop browser", () => {
        const page = describeClient(PAGE_AGENT, PAGE_BRANDS, PAGE_PLATFORM);
        const chrome = describeClient(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36",
            '"Chromium";v="157", "Google Chrome";v="157", "Not?A_Brand";v="99"',
            '"Windows"'
        );
        expect(
            bindingBreach(
                { bindClient: true, pinScope: "off", pinThisSession: null },
                {
                    os: page.os,
                    browser: page.browser,
                    claimedOs: page.os,
                    claimedBrowser: page.browser,
                    brandHinted: true,
                    platformHinted: true,
                    ip: "198.51.100.7",
                    handheld: true
                },
                {
                    os: chrome.os,
                    browser: chrome.browser,
                    claimedOs: chrome.os,
                    claimedBrowser: chrome.browser,
                    brandHinted: true,
                    platformHinted: true,
                    ip: "203.0.113.9"
                }
            )
        ).toBe("client");
    });
});
