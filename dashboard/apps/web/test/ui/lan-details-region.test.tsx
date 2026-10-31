// @vitest-environment jsdom
/**
 * The network section of a detail screen: its heading stands only over
 * something, and a failed read says so rather than leaving the section empty.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LanDetailsRegion } from "@polaris/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const labels = { address: "IP address", mac: "MAC address" };

function region(load: () => Promise<{ address: string; mac: null } | null>) {
    return render(
        <LanDetailsRegion load={load} labels={labels} title="Network" failed="Could not read it." />
    );
}

afterEach(cleanup);

describe("LanDetailsRegion", () => {
    it("shows the heading over what it read", async () => {
        region(async () => ({ address: "192.168.1.10", mac: null }));
        expect(screen.getByRole("heading", { name: "Network" })).toBeTruthy();
        expect(await screen.findByText("192.168.1.10")).toBeTruthy();
    });

    it("leaves nothing behind when there is nothing to show", async () => {
        const { container } = region(async () => null);
        await waitFor(() => expect(container.innerHTML).toBe(""));
    });

    it("says so when the read fails", async () => {
        region(async () => {
            throw new Error("offline");
        });
        expect((await screen.findByRole("alert")).textContent).toBe("Could not read it.");
        expect(screen.getByRole("heading", { name: "Network" })).toBeTruthy();
    });
});
