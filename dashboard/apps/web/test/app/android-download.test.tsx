// @vitest-environment jsdom

/**
 * Every way to install Polaris on Android, best first: Google Play, then
 * F-Droid, then the APK. A store is offered only once it carries the app, and
 * the APK only while a release has one.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AndroidFilesOffer } from "@/components/app-download";
import {
    FDROID_LISTING_URL,
    PLAY_LISTING_URL
} from "@polaris/ui/account-downloads/store-listings";
import { withMessages } from "../setup/i18n";

const release = {
    url: "https://github.com/example/polaris/releases/tag/android-v0.1.4",
    version: "0.1.4",
    files: [
        {
            name: "polaris-android.apk",
            url: "https://github.com/example/polaris/releases/download/android-v0.1.4/polaris-android.apk"
        },
        { name: "SHA256SUMS", url: "https://github.com/example/polaris/releases/download/x/SHA256SUMS" }
    ]
};

const none = { play: null, fdroid: null };

describe("the Android offer", () => {
    it("puts Google Play first, then F-Droid, then the APK", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <AndroidFilesOffer
                    download={release}
                    stores={{ play: PLAY_LISTING_URL, fdroid: FDROID_LISTING_URL }}
                />
            )
        );
        const play = html.indexOf(`href="${PLAY_LISTING_URL.replace(/&/g, "&amp;")}"`);
        const fdroid = html.indexOf(`href="${FDROID_LISTING_URL}"`);
        const apk = html.indexOf('href="https://github.com/example/polaris/releases/download/android-v0.1.4/polaris-android.apk"');
        expect(play).toBeGreaterThan(-1);
        expect(fdroid).toBeGreaterThan(play);
        expect(apk).toBeGreaterThan(fdroid);
        // Recommended once, on Google Play.
        expect(html.match(/Recommended/g)).toHaveLength(1);
        expect(html.indexOf("Recommended")).toBeLessThan(fdroid);
    });

    it("offers no store that does not carry the app, and the APK as the way in", () => {
        const html = renderToStaticMarkup(
            withMessages(<AndroidFilesOffer download={release} stores={none} />)
        );
        expect(html).not.toContain("Google Play");
        expect(html).not.toContain("F-Droid");
        expect(html).toContain("polaris-android.apk");
        expect(html).toContain("0.1.4");
        // One way in is nothing to recommend over.
        expect(html).not.toContain("Recommended");
    });

    it("says it is not out yet when there is no release, with nothing to press", () => {
        const html = renderToStaticMarkup(
            withMessages(<AndroidFilesOffer download={null} stores={none} />)
        );
        expect(html).toContain("Not released yet.");
        expect(html).not.toContain("href=");
    });

    it("links to the releases when GitHub did not answer", () => {
        const html = renderToStaticMarkup(
            withMessages(
                <AndroidFilesOffer download={null} stores={none} unreachable="example/polaris" />
            )
        );
        expect(html).toContain('href="https://github.com/example/polaris/releases"');
    });
});
