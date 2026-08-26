// @vitest-environment jsdom

/**
 * The call server card points at Settings when its container was never
 * created, and at Containers - naming the container - when it exists but is
 * stopped. Both used to point somewhere that does not exist or leave the
 * container to be found by guesswork; this locks the two destinations down.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CallServerView } from "@/app/(app)/admin/chat/call-server-view";

let settings: Record<string, unknown> = {};

vi.mock("@/app/(app)/admin/chat/actions", () => ({
    callServerSettingsAction: async () => ({ settings, error: null }),
    setCallServerAction: async () => ({})
}));

afterEach(cleanup);

const BASE = {
    url: "",
    key: "",
    hasSecret: false,
    shipped: true,
    ready: true,
    answering: false,
    unused: null
};

describe("where calls run - container problem links", () => {
    it("points a never-created container at Settings, Update", async () => {
        settings = { ...BASE, container: "missing" };
        render(<CallServerView />);

        const link = await screen.findByRole("link", { name: "Settings" });
        expect(link.getAttribute("href")).toBe("/admin/settings");
        expect(screen.getByText(/, Update\.$/)).toBeTruthy();
    });

    it("points a stopped container at Containers and names the row", async () => {
        settings = { ...BASE, container: "stopped" };
        render(<CallServerView />);

        const link = await screen.findByRole("link", { name: "Containers" });
        expect(link.getAttribute("href")).toBe("/apps/containers");
        expect(screen.getByText(/polaris-livekit-1/)).toBeTruthy();
    });
});
