// @vitest-environment jsdom
/**
 * The mark drawn beside a Polaris app's name in every list: its logo when it
 * has one, its own icon on a tinted tile when it does not, the initial of a
 * heading that is no single app, and nothing at all with neither - always at
 * the size asked for and never shrunk by a long name beside it.
 */

import { Box, HardDrive } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

// Every app in the real registry has a logo today; a fixture app stands in for
// the next one added without one.
vi.mock("@/lib/apps", () => ({
    POLARIS_APPS: [
        { id: "drive", icon: HardDrive },
        { id: "fixture-app", icon: Box }
    ]
}));

const { PolarisAppIcon, isPolarisApp } = await import("@/components/polaris-app-icon");

afterEach(cleanup);

describe("PolarisAppIcon", () => {
    it("draws the app's own logo at the size asked for", () => {
        const { container } = render(<PolarisAppIcon appId="drive" size={20} />);
        const logo = container.querySelector("svg[data-app-logo='drive']") as SVGElement | null;
        expect(logo).not.toBeNull();
        expect(logo!.style.width).toBe("20px");
        expect(logo!.style.flexShrink).toBe("0");
        expect(logo!.getAttribute("class")).toContain("shrink-0");
    });

    it("wears the registry icon on a tinted tile for an app without a logo", () => {
        const { container } = render(<PolarisAppIcon appId="fixture-app" />);
        const tile = container.querySelector("[data-app-icon='fixture-app']") as HTMLElement | null;
        expect(tile).not.toBeNull();
        expect(tile!.className).toContain("shrink-0");
        expect(tile!.style.width).toBe("16px");
        expect(tile!.querySelector("svg")).not.toBeNull();
    });

    it("draws a heading's initial when it is no single app", () => {
        const { container } = render(<PolarisAppIcon appId={undefined} label="Productivity" />);
        const tile = container.querySelector("[data-app-icon='initial']");
        expect(tile?.textContent).toBe("P");
        expect(tile?.getAttribute("aria-hidden")).toBe("true");
    });

    it("draws nothing for something that is neither an app nor named", () => {
        const { container } = render(<PolarisAppIcon appId="auth" />);
        expect(container.innerHTML).toBe("");
        expect(isPolarisApp("auth")).toBe(false);
        expect(isPolarisApp("drive")).toBe(true);
        expect(isPolarisApp("fixture-app")).toBe(true);
    });
});
