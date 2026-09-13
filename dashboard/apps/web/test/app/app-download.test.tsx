// @vitest-environment jsdom

/**
 * The two states of each app's download offer.
 *
 * Both used to be a link built out of the repository's name whether or not anything
 * was there, which is a button leading to a page reading "No releases found". So
 * what is asserted here is that a link is drawn only for a release that exists, and
 * that its absence still says the app is real - hiding the whole thing would leave
 * somebody who has heard of it looking for a button nobody drew.
 *
 * These halves take the answer rather than fetching it, so nothing here needs a
 * network; finding the release is covered in `updates/app-releases`.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopDownloadOffer, ExtensionDownloadOffer } from "@/components/app-download";

describe("the desktop app's offer", () => {
    it("offers the download when a release exists, and names the version", () => {
        const html = renderToStaticMarkup(
            <DesktopDownloadOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
                    version: "0.2.0"
                }}
            />
        );
        expect(html).toContain(
            'href="https://github.com/example/polaris/releases/tag/desktop-v0.2.0"'
        );
        expect(html).toContain("Download the desktop app");
        expect(html).toContain("0.2.0");
    });

    it("says the app exists but gives nothing to press when it has no release", () => {
        const html = renderToStaticMarkup(<DesktopDownloadOffer download={null} />);
        expect(html).toContain("Download the desktop app");
        expect(html).toContain("Not released yet");
        expect(html).toContain("disabled");
        expect(html).not.toContain("href=");
    });
});

describe("the extension's offer", () => {
    it("offers the package when one has been published, and names the version", () => {
        const html = renderToStaticMarkup(
            <ExtensionDownloadOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/extension-v0.1.0",
                    version: "0.1.0"
                }}
            />
        );
        expect(html).toContain(
            'href="https://github.com/example/polaris/releases/tag/extension-v0.1.0"'
        );
        expect(html).toContain("0.1.0");
        expect(html).not.toContain("nothing to load");
    });

    it("says why there is nothing to press when none has been", () => {
        const html = renderToStaticMarkup(<ExtensionDownloadOffer download={null} />);
        expect(html).toContain("Download the extension");
        expect(html).toContain("nothing to load");
        expect(html).toContain("disabled");
        expect(html).not.toContain("href=");
    });
});
