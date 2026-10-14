// @vitest-environment jsdom

/**
 * What an uninstall left behind, on the Servers Storage screen.
 *
 * An uninstall used to stop at the database row: the containers, their private
 * networks, the compose directory and the edge route all stayed on the machine
 * with nothing in Polaris mentioning them again. This is the list that finds
 * them, and the one button that removes them all together - never the volumes,
 * which stay listed above and go one at a time with their own confirmation.
 */

import { MessagesWrapper } from "../setup/i18n";
import type { HostVolume } from "@/lib/deploy/host-volumes";
import type { Leftovers } from "@/lib/deploy/uninstall-leftovers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const hostSpaceAction = vi.fn();
const reclaimBuildCacheAction = vi.fn();
const reclaimHostSpaceAction = vi.fn();
const hostVolumesAction = vi.fn();
const leftoverAutoRemoveAction = vi.fn();
const removeHostVolumeAction = vi.fn();
const setLeftoverAutoRemoveAction = vi.fn();
const removeStrayContainerAction = vi.fn();
const cleanUninstallLeftoversAction = vi.fn();
const uninstallLeftoversAction = vi.fn();
const volumeMovesAction = vi.fn();

vi.mock("../../src/app/(app)/apps/servers/actions", () => ({
    hostSpaceAction,
    reclaimBuildCacheAction,
    reclaimHostSpaceAction,
    hostVolumesAction,
    leftoverAutoRemoveAction,
    removeHostVolumeAction,
    setLeftoverAutoRemoveAction,
    removeStrayContainerAction,
    cleanUninstallLeftoversAction,
    uninstallLeftoversAction,
    volumeMovesAction
}));

const { ServerStorage } = await import("../../src/app/(app)/apps/servers/server-storage");

const leftovers: Leftovers = {
    containers: [
        {
            id: "c1",
            name: "polaris-a1b2c3d4-web-1",
            image: "polaris/web:1.4.0",
            project: "polaris-a1b2c3d4",
            running: false,
            status: "Exited (0) 3 days ago",
            createdAt: "2026-07-01T00:00:00.000Z"
        }
    ],
    networks: ["polaris-net-a1b2c3d4"],
    dirs: ["polaris-a1b2c3d4"],
    routes: ["018f2b7a-0000-7000-8000-0000000000f6"]
};

const removedAppVolume: HostVolume = {
    name: "polaris-a1b2c3d4-data",
    bytes: 42 * 1024 * 1024,
    inUse: false,
    heldBy: [],
    project: "polaris-a1b2c3d4",
    createdAt: "2026-07-01T00:00:00.000Z",
    owner: null,
    browseHref: null,
    spare: true,
    removedApp: true,
    description: null,
    lastUsedAt: null,
    notedSince: "2026-07-01T00:00:00.000Z",
    advice: { safe: true, reason: null }
} as HostVolume;

beforeEach(() => {
    vi.clearAllMocks();
    hostSpaceAction.mockResolvedValue(null);
    hostVolumesAction.mockResolvedValue([removedAppVolume]);
    leftoverAutoRemoveAction.mockResolvedValue(true);
    volumeMovesAction.mockResolvedValue({ moves: [], canAnswer: false });
    uninstallLeftoversAction.mockResolvedValue(leftovers);
});

afterEach(cleanup);

describe("what an uninstall left behind", () => {
    it("names each leftover by kind and lets the operator clean them up together", async () => {
        render(<ServerStorage />, { wrapper: MessagesWrapper });

        const heading = await screen.findByRole("heading", { name: "Left behind" });
        const section = heading.closest("section") as HTMLElement;

        expect(within(section).getByText("polaris-a1b2c3d4-web-1")).toBeTruthy();
        expect(within(section).getByText("polaris-net-a1b2c3d4")).toBeTruthy();
        expect(within(section).getByText("polaris-a1b2c3d4")).toBeTruthy();
        expect(
            within(section).getByText("polaris-app-018f2b7a-0000-7000-8000-0000000000f6")
        ).toBeTruthy();
        expect(within(section).getByText("Container")).toBeTruthy();
        expect(within(section).getByText("Network")).toBeTruthy();
        expect(within(section).getByText("Deploy folder")).toBeTruthy();
        expect(within(section).getByText("Edge route")).toBeTruthy();

        // The volume a removed app owned reads as left behind too, apart from
        // the non-data leftovers above - it is never swept with them.
        expect(
            screen.getByText((_, node) =>
                (node?.textContent ?? "").startsWith("Left by a removed app (polaris-a1b2c3d4)")
            )
        ).toBeTruthy();

        cleanUninstallLeftoversAction.mockResolvedValueOnce({
            removed: { containers: 1, networks: 1, dirs: 1, routes: 1 }
        });
        uninstallLeftoversAction.mockResolvedValueOnce({
            containers: [],
            networks: [],
            dirs: [],
            routes: []
        });

        fireEvent.click(within(section).getByRole("button", { name: "Clean up" }));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Clean up 4 leftovers?")).toBeTruthy();
        fireEvent.click(within(dialog).getByRole("button", { name: "Clean up" }));

        await waitFor(() => expect(cleanUninstallLeftoversAction).toHaveBeenCalledTimes(1));
        expect(await screen.findByText("Cleaned up 4 leftovers.")).toBeTruthy();
        expect(screen.queryByRole("heading", { name: "Left behind" })).toBeNull();
    });
});
