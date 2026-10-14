// @vitest-environment jsdom

/**
 * The skin dialog: it shows what the player wears, offers changing it only to
 * whoever may, previews an import before Apply, shows what the server holds
 * after it, and says when the server's mod is too old for skins.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirm = vi.fn(async () => true);

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useLocale: () => "en-US" },
        confirmDialog: { useConfirm: () => [confirm, null] }
    }
}));

vi.mock("skinview3d", () => ({
    SkinViewer: class {
        controls = { enablePan: true, enableRotate: false };
        loadSkin = vi.fn(async () => undefined);
        dispose = vi.fn();
    }
}));

vi.mock("@polaris-app/game-servers/src/screens/installed/restart-planner", () => ({
    RestartPlanner: ({ title }: { title?: string }) => <p>planner: {title}</p>
}));

const actions = {
    readSkinAction: vi.fn(),
    previewSkinAction: vi.fn(),
    applySkinAction: vi.fn(),
    clearSkinAction: vi.fn()
};
vi.mock("@polaris-app/game-servers/src/screens/installed/skin-actions", () => actions);

const { SkinDialog } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-skin-dialog"
);

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

const INSTALLED = "00000000-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const PNG = "iVBORw0KGgo=";

function open(canEdit: boolean, canRestart = false) {
    render(
        <SkinDialog
            installedAppId={INSTALLED}
            player="player-one"
            canEdit={canEdit}
            online
            running
            canRestart={canRestart}
            onClose={() => undefined}
        />
    );
}

describe("SkinDialog", () => {
    it("shows the skin worn now and offers no changes to a reader", async () => {
        actions.readSkinAction.mockResolvedValue({
            live: { state: "read", skin: { hash: HASH, model: "slim", signed: true } }
        });
        open(false);
        expect(await screen.findByText("Wearing now - Slim")).toBeTruthy();
        expect(screen.getByRole("img", { name: /3D view of the skin/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Reset to account skin" })).toBeNull();
        // A reader is never sent through the moderator-only fetch.
        expect(actions.previewSkinAction).not.toHaveBeenCalled();
    });

    it("previews a username before Apply, then shows what the server holds", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "read", skin: null } });
        actions.previewSkinAction.mockResolvedValue({ png: PNG, model: "classic", signed: null });
        actions.applySkinAction.mockResolvedValue({
            live: { state: "read", skin: { hash: HASH, model: "slim", signed: true } }
        });
        open(true);
        expect(await screen.findByText("Their account's own skin")).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("Username or link"), {
            target: { value: "player-two" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Load" }));
        expect(await screen.findByText("Preview only. Apply to put it on.")).toBeTruthy();
        expect(actions.previewSkinAction).toHaveBeenCalledWith({
            installedAppId: INSTALLED,
            player: "player-one",
            kind: "text",
            text: "player-two"
        });

        fireEvent.click(screen.getByRole("radio", { name: "Slim" }));
        fireEvent.click(screen.getByRole("button", { name: "Apply" }));
        expect(await screen.findByText("Skin applied.")).toBeTruthy();
        expect(actions.applySkinAction).toHaveBeenCalledWith({
            installedAppId: INSTALLED,
            player: "player-one",
            png: PNG,
            model: "slim",
            signed: null
        });
        await waitFor(() => expect(screen.getByText("Wearing now - Slim")).toBeTruthy());
    });

    it("shows an import's failure inline", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "read", skin: null } });
        actions.previewSkinAction.mockResolvedValue({
            error: "No Minecraft account has that name."
        });
        open(true);
        await screen.findByText("Their account's own skin");
        fireEvent.change(screen.getByPlaceholderText("Username or link"), {
            target: { value: "nobody_here" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Load" }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "No Minecraft account has that name."
        );
        expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    });

    it("says the mod is too old and offers the restart that updates it", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "unsupported" } });
        open(true, true);
        expect(await screen.findByText(/older than skins/)).toBeTruthy();
        expect(screen.getByText("planner: Skins need the newer Polaris mod")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
    });
});
