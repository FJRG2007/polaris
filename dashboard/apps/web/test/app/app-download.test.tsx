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
import {
    DesktopDownloadOffer,
    DesktopFilesOffer,
    ExtensionDownloadOffer,
    ExtensionFilesOffer
} from "@/components/app-download";

describe("the desktop app's offer", () => {
    it("offers the download when a release exists, and names the version", () => {
        const html = renderToStaticMarkup(
            <DesktopDownloadOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
                    version: "0.2.0",
                    files: []
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

/**
 * The download centre's rows, which name a platform rather than a filename.
 *
 * The files on a release are named by their packagers - forge writes
 * `Polaris-0.2.0-arm64.dmg`, WXT writes `polaris-0.1.0-firefox.zip` - and none of
 * that is what somebody looking for a Mac download reads for. So each row says
 * what it is and picks its own file, and the two ways that goes wrong are a row
 * linking the wrong file and a row linking nothing while looking like a button.
 */
describe("the desktop app's files", () => {
    const files = [
        { name: "Polaris-Setup.exe", url: "https://example.test/Polaris-Setup.exe" },
        { name: "Polaris-0.2.0-arm64.dmg", url: "https://example.test/arm64.dmg" },
        { name: "Polaris-0.2.0-x64.dmg", url: "https://example.test/x64.dmg" },
        { name: "polaris-desktop_0.2.0_amd64.deb", url: "https://example.test/polaris.deb" },
        { name: "Polaris-0.2.0-x64.AppImage", url: "https://example.test/polaris.AppImage" }
    ];

    it("gives every platform its own file", () => {
        const html = renderToStaticMarkup(
            <DesktopFilesOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
                    version: "0.2.0",
                    files
                }}
            />
        );
        expect(html).toContain("0.2.0");
        expect(html).toContain('href="https://example.test/Polaris-Setup.exe"');
        expect(html).toContain('href="https://example.test/arm64.dmg"');
        expect(html).toContain('href="https://example.test/x64.dmg"');
        expect(html).toContain('href="https://example.test/polaris.deb"');
        expect(html).toContain('href="https://example.test/polaris.AppImage"');
        expect(html).not.toContain("Not in this release");
    });

    it("keeps the two Mac images apart", () => {
        // One `.dmg` match for both architectures would hand an Intel Mac the
        // Apple-silicon image, which opens and then refuses to run.
        const html = renderToStaticMarkup(
            <DesktopFilesOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
                    version: "0.2.0",
                    files: [files[1]!, files[2]!]
                }}
            />
        );
        const silicon = html.indexOf("Apple silicon");
        const intel = html.indexOf("macOS, Intel");
        expect(silicon).toBeGreaterThan(-1);
        expect(intel).toBeGreaterThan(silicon);
        expect(html.slice(silicon, intel)).toContain("arm64.dmg");
        expect(html.slice(intel)).toContain("x64.dmg");
    });

    it("says which platform is missing from a release that has the others", () => {
        const html = renderToStaticMarkup(
            <DesktopFilesOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/desktop-v0.2.0",
                    version: "0.2.0",
                    files: [files[0]!]
                }}
            />
        );
        expect(html).toContain('href="https://example.test/Polaris-Setup.exe"');
        expect(html).toContain("Not in this release");
    });

    it("offers nothing to press when nothing has been released", () => {
        const html = renderToStaticMarkup(<DesktopFilesOffer download={null} />);
        expect(html).toContain("Not released yet");
        expect(html).not.toContain("href=");
    });
});

describe("the extension's files", () => {
    it("offers the package for each browser, never the sources archive", () => {
        // The sources archive is a zip on the same release, and handing it to
        // somebody as the add-on is a download that installs nothing.
        const html = renderToStaticMarkup(
            <ExtensionFilesOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/extension-v0.1.0",
                    version: "0.1.0",
                    files: [
                        { name: "polaris-0.1.0-sources.zip", url: "https://example.test/sources.zip" },
                        { name: "polaris-0.1.0-chrome.zip", url: "https://example.test/chrome.zip" },
                        { name: "polaris-0.1.0-firefox.zip", url: "https://example.test/firefox.zip" }
                    ]
                }}
            />
        );
        expect(html).toContain('href="https://example.test/chrome.zip"');
        expect(html).toContain('href="https://example.test/firefox.zip"');
        expect(html).not.toContain("sources.zip");
    });

    it("says none has been published rather than drawing empty rows", () => {
        const html = renderToStaticMarkup(<ExtensionFilesOffer download={null} />);
        expect(html).toContain("No package has been published yet");
        expect(html).not.toContain("href=");
    });
});

describe("the extension's offer", () => {
    it("offers the package when one has been published, and names the version", () => {
        const html = renderToStaticMarkup(
            <ExtensionDownloadOffer
                download={{
                    url: "https://github.com/example/polaris/releases/tag/extension-v0.1.0",
                    version: "0.1.0",
                    files: []
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
