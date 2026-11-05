// @vitest-environment jsdom

/**
 * An installed Polaris app's update, on its card in the Polaris apps grid: the
 * new version and Update where Open was, how far it got, and why it did not.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateRow } from "@/lib/app-bundles/actions";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";
import { appUpdatesAction, changeAppBuildAction } from "@/lib/app-bundles/actions";
import type { StoreInstallRow } from "@/app/(app)/apps/marketplace/marketplace-view";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/app-bundles/actions", () => ({
    appUpdatesAction: vi.fn(),
    changeAppBuildAction: vi.fn()
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/app/(app)/apps/deploy/actions", () => ({
    listDeployServersAction: vi.fn(async () => []),
    createApplicationAction: vi.fn()
}));
vi.mock("@/app/(app)/apps/marketplace/actions", () => ({
    installAppAction: vi.fn(),
    listStorageConnectionsAction: vi.fn(async () => [])
}));
vi.mock("@/app/(app)/apps/installed/[id]/actions", () => ({
    uninstallInstalledAppAction: vi.fn()
}));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const install: StoreInstallRow = {
    id: "install-1",
    catalogId: "game-servers",
    name: "Game servers",
    status: "running",
    applicationId: null,
    targetId: null,
    createdAt: new Date("2026-01-01").toISOString(),
    ownerId: "owner-1",
    canUninstall: true
};

function row(over: { runs?: boolean; newer?: boolean } = {}): AppUpdateRow {
    const { runs = true, newer = true } = over;
    return {
        id: "game-servers",
        name: "Game servers",
        running: true,
        installed: { digest: "sha256:aaaaaaa111", version: "1.0.0", source: "image" },
        previous: null,
        available: newer
            ? { digest: "sha256:bbbbbbb222", version: "1.1.0", hostApi: "1", runs }
            : null,
        checkFailed: false,
        progress: null
    } as unknown as AppUpdateRow;
}

function renderGrid(canUpdateApps = true) {
    return render(
        <MarketplaceView scope="polaris" installed={[install]} canUpdateApps={canUpdateApps} />,
        { wrapper: MessagesWrapper }
    );
}

describe("an app update on its card", () => {
    it("paints the card first, then shows the new version and Update", async () => {
        let answer: (rows: AppUpdateRow[]) => void = () => undefined;
        vi.mocked(appUpdatesAction).mockReturnValue(new Promise((done) => (answer = done)));
        renderGrid();

        // The grid is there before the rows answer; only the card that waits says so.
        expect(screen.getByLabelText("More for Game servers")).toBeTruthy();
        expect(screen.getByRole("status", { name: "Checking for updates" })).toBeTruthy();

        answer([row()]);
        expect(await screen.findByText("1.1.0 (bbbbbbb) available")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
        expect(screen.getByText("1 update available")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Update all apps" })).toBeTruthy();
        expect(appUpdatesAction).toHaveBeenCalledWith(true);
    });

    it("shows the update under way, and puts the card back with why when it is refused", async () => {
        vi.mocked(appUpdatesAction).mockResolvedValue([row()]);
        let answer: (value: Awaited<ReturnType<typeof changeAppBuildAction>>) => void = () =>
            undefined;
        vi.mocked(changeAppBuildAction).mockReturnValue(new Promise((done) => (answer = done)));
        renderGrid();

        fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
        expect(changeAppBuildAction).toHaveBeenCalledWith("game-servers", "update");
        const busy = await screen.findAllByRole("button", { name: /Updating/ });
        for (const button of busy) expect((button as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByRole("progressbar")).toBeTruthy();

        answer({ rows: [row()], refused: "unreachable" });
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.getByText(/could not be downloaded/)).toBeTruthy();
        expect(screen.queryByRole("progressbar")).toBeNull();
        expect(screen.getByRole("button", { name: "Update now" })).toBeTruthy();
    });

    it("says a version needs a newer Polaris and offers nothing to press", async () => {
        vi.mocked(appUpdatesAction).mockResolvedValue([row({ runs: false })]);
        renderGrid();

        expect(await screen.findByText("1.1.0 (bbbbbbb) needs a newer Polaris")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Update all apps" })).toBeNull();
    });

    it("keeps Open on a card that is up to date", async () => {
        vi.mocked(appUpdatesAction).mockResolvedValue([row({ newer: false })]);
        renderGrid();

        expect(await screen.findByText("Installed 1.0.0 (aaaaaaa)")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    });

    it("shows a native app's update on the built-in card it runs in, and updates it with the rest", async () => {
        const native = { ...row(), id: "security-scans", name: "Security scans" } as AppUpdateRow;
        vi.mocked(appUpdatesAction).mockResolvedValue([row(), native]);
        vi.mocked(changeAppBuildAction).mockImplementation(async (id) => ({
            rows: [
                row({ newer: false }),
                id === "security-scans" ? ({ ...native, available: null } as AppUpdateRow) : native
            ]
        }));
        const { container } = renderGrid();

        await screen.findByText("2 updates available");
        const note = container.querySelector(
            '[data-built-in="apps"] [data-native-update="security-scans"]'
        );
        expect(note?.textContent).toContain("Security scans");
        expect(note?.textContent).toContain("1.1.0 (bbbbbbb) available");
        expect(container.querySelector('[data-native-update="cloud-servers"]')).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Update all apps" }));
        await waitFor(() => expect(changeAppBuildAction).toHaveBeenCalledTimes(2));
        expect(changeAppBuildAction).toHaveBeenCalledWith("game-servers", "update");
        expect(changeAppBuildAction).toHaveBeenCalledWith("security-scans", "update");
    });

    it("says when the updates could not be checked, and checks again on request", async () => {
        vi.mocked(appUpdatesAction).mockRejectedValueOnce(new Error("down"));
        vi.mocked(appUpdatesAction).mockResolvedValueOnce([row()]);
        renderGrid();

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("Could not check for updates");
        fireEvent.click(screen.getByRole("button", { name: "Check for app updates" }));
        expect(await screen.findByText("1.1.0 (bbbbbbb) available")).toBeTruthy();
        expect(screen.queryByRole("alert")).toBeNull();
        expect(appUpdatesAction).toHaveBeenLastCalledWith(true);
    });

    it("asks nothing for a reader the update action would refuse", async () => {
        renderGrid(false);
        await waitFor(() => expect(screen.getByLabelText("More for Game servers")).toBeTruthy());
        expect(appUpdatesAction).not.toHaveBeenCalled();
        expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    });
});
