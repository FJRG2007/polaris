// @vitest-environment jsdom

/**
 * The install guide: which steps and pictures each file gets, which browser and
 * system the pictures are drawn for (and the neutral fallback when neither is
 * known), and that nothing in them moves for a reader who asked for less motion.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
    GuideDownloadLink,
    InstallGuideDialog,
    type InstallGuideContent
} from "../src/downloads/install-guide";
import {
    detectGuideBrowser,
    detectGuideOs,
    GUIDE_ITEMS,
    guideSteps
} from "../src/downloads/install-guide-steps";

afterEach(cleanup);

const CHROME_WIN =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
const SAFARI_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const SAFARI_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

describe("guideSteps", () => {
    it("gives every item open, install and use, keyed under its own name", () => {
        for (const item of GUIDE_ITEMS) {
            const steps = guideSteps(item);
            expect(steps.map((step) => step.id)).toEqual(["open", "install", "use"]);
            expect(steps.map((step) => step.bodyKey)).toEqual([
                `downloads.guide.items.${item}.open`,
                `downloads.guide.items.${item}.install`,
                `downloads.guide.items.${item}.use`
            ]);
        }
    });

    it("draws an extension in the browser's toolbar and everything else on the system's dock", () => {
        expect(guideSteps("extension-chromium").map((step) => step.art)).toEqual([
            "download",
            "progress",
            "toolbar"
        ]);
        expect(guideSteps("extension-firefox")[2].art).toBe("toolbar");
        expect(guideSteps("streamdeck").map((step) => step.art)).toEqual([
            "download",
            "progress",
            "dock"
        ]);
        expect(guideSteps("companion")[2].art).toBe("dock");
        expect(guideSteps("desktop")[2].art).toBe("dock");
    });
});

describe("detection", () => {
    it("reads the browser from the user agent", () => {
        expect(detectGuideBrowser(CHROME_WIN)).toBe("chromium");
        expect(detectGuideBrowser(FIREFOX_LINUX)).toBe("firefox");
        expect(detectGuideBrowser(SAFARI_MAC)).toBe("safari");
    });

    it("prefers client hints, so Brave and Edge count as Chromium", () => {
        expect(detectGuideBrowser("Mozilla/5.0", { brands: [{ brand: "Brave" }] })).toBe(
            "chromium"
        );
        expect(detectGuideBrowser("Mozilla/5.0", { brands: [{ brand: "Microsoft Edge" }] })).toBe(
            "chromium"
        );
        expect(detectGuideOs("Mozilla/5.0", { platform: "macOS" })).toBe("macos");
    });

    it("reads the system, and leaves phones and unknown agents neutral", () => {
        expect(detectGuideOs(CHROME_WIN)).toBe("windows");
        expect(detectGuideOs(FIREFOX_LINUX)).toBe("linux");
        expect(detectGuideOs(SAFARI_MAC)).toBe("macos");
        expect(detectGuideOs(SAFARI_IPHONE)).toBe("neutral");
        expect(detectGuideOs("")).toBe("neutral");
        expect(detectGuideBrowser("")).toBe("neutral");
    });
});

const content: InstallGuideContent = {
    title: "Install and open it",
    description: "The download should have started.",
    fileName: "polaris-1.0.0.streamDeckPlugin",
    appName: "Polaris",
    doneLabel: "Done",
    steps: guideSteps("streamdeck").map((step, index) => ({
        art: step.art,
        label: `Step ${index + 1}`,
        title: step.id,
        body: `body ${step.id}`
    }))
};

describe("InstallGuideDialog", () => {
    it("shows the three steps with the file in the download list", () => {
        render(
            <InstallGuideDialog
                open
                onOpenChange={() => {}}
                content={content}
                browser="firefox"
                os="macos"
            />
        );
        expect(screen.getByText("Install and open it")).toBeTruthy();
        expect(screen.getAllByRole("listitem")).toHaveLength(3);
        expect(screen.getByText("Step 3")).toBeTruthy();
        expect(screen.getByText(content.fileName)).toBeTruthy();
        expect(document.querySelector('[data-browser="firefox"]')).toBeTruthy();
        expect(document.querySelector('[data-os="macos"]')).toBeTruthy();
    });

    it("stacks the cards on a phone and sets them side by side from sm up", () => {
        render(
            <InstallGuideDialog
                open
                onOpenChange={() => {}}
                content={content}
                browser="neutral"
                os="neutral"
            />
        );
        const list = screen.getAllByRole("listitem")[0].parentElement!;
        expect(list.className).toContain("grid-cols-1");
        expect(list.className).toContain("sm:grid-cols-3");
    });

    it("moves nothing unless motion is allowed", () => {
        render(
            <InstallGuideDialog
                open
                onOpenChange={() => {}}
                content={content}
                browser="chromium"
                os="windows"
            />
        );
        const moving = Array.from(document.querySelectorAll("[data-motion]"));
        expect(moving.length).toBeGreaterThanOrEqual(3);
        for (const element of moving) {
            const animations = element
                .getAttribute("class")!
                .split(/\s+/)
                .filter((name) => name.includes("animate"));
            expect(animations.length).toBeGreaterThan(0);
            for (const name of animations) expect(name.startsWith("motion-safe:")).toBe(true);
        }
    });
});

describe("GuideDownloadLink", () => {
    it("downloads the file and opens the guide in the same press", () => {
        render(
            <GuideDownloadLink href="https://example.test/file.zip" content={content}>
                Download
            </GuideDownloadLink>
        );
        const link = screen.getByText("Download").closest("a")!;
        expect(link.getAttribute("href")).toBe("https://example.test/file.zip");
        expect(link.hasAttribute("download")).toBe(true);
        expect(screen.queryByText("Install and open it")).toBeNull();
        fireEvent.click(link);
        expect(screen.getByText("Install and open it")).toBeTruthy();
    });
});
