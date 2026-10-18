// @vitest-environment jsdom

/**
 * The skin dialog: it shows what the player wears, offers changing it only to
 * whoever may, previews an import before Apply, shows what the server holds
 * after it, and says when the server's mod is too old for skins.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSkin } from "@polaris-app/game-servers/src/lib/minecraft/default-skin";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const confirm = vi.fn(async () => true);
const picker = vi.fn((props: { accept?: string }) => (
    <div role="dialog" aria-label="Shared file picker" data-accept={props.accept} />
));

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        i18nProvider: { useLocale: () => "en-US" },
        confirmDialog: { useConfirm: () => [confirm, null] },
        filePicker: { ChooseFilesDialog: (props: { accept?: string }) => picker(props) }
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

function open(canEdit: boolean, canRestart = false, online = true) {
    render(
        <SkinDialog
            installedAppId={INSTALLED}
            player="player-one"
            canEdit={canEdit}
            online={online}
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
        // Nothing to draw for a profile with no skin of its own, and it says why.
        expect(screen.getByText("Minecraft's default skin")).toBeTruthy();

        fireEvent.change(screen.getByPlaceholderText("Username or link"), {
            target: { value: "player-two" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Load" }));
        expect(await screen.findByText("Preview only. Apply to put it on.")).toBeTruthy();
        expect(screen.queryByText("Minecraft's default skin")).toBeNull();
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

    it("draws the default skin the game picks from a known UUID, and names it", async () => {
        const uuid = "00000000-0000-4000-8000-000000000001";
        actions.readSkinAction.mockResolvedValue({ live: { state: "read", skin: null }, uuid });
        open(true);
        const { name } = defaultSkin(uuid);
        const caption = `Minecraft's default skin - ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
        expect(await screen.findByText(caption)).toBeTruthy();
        expect(screen.queryByText("Minecraft's default skin")).toBeNull();
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

    it("reads a linked player's own skin once", async () => {
        actions.readSkinAction.mockResolvedValue({
            live: { state: "read", skin: { hash: HASH, model: "slim", signed: true } },
            ownSkin: true
        });
        actions.previewSkinAction.mockResolvedValue({ png: PNG, model: "slim", signed: null });
        open(false);
        expect(await screen.findByRole("button", { name: "Load" })).toBeTruthy();
        await waitFor(() => expect(actions.previewSkinAction).toHaveBeenCalledTimes(1));
        expect(actions.readSkinAction).toHaveBeenCalledTimes(1);
    });

    it("offers no change to a player who is not on the server, and says why", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "refused", why: "offline" } });
        open(true, false, false);
        expect(await screen.findByText(/player-one is not on the server/)).toBeTruthy();
        expect(screen.queryByText("Their account's own skin")).toBeNull();
        expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
    });

    it("lets a skin be set for a player who is not on, for their next join", async () => {
        actions.readSkinAction.mockResolvedValue({
            live: { state: "read", skin: null, offline: true },
            uuid: "00000000-0000-4000-8000-000000000001"
        });
        open(true, false, false);
        expect(
            await screen.findByText(
                "player-one is not on the server. A change goes on when they next join."
            )
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Load" })).toBeTruthy();
        expect(screen.getByText("Their account's own skin")).toBeTruthy();
        expect(screen.queryByText(/Minecraft's default skin/)).toBeNull();
    });

    it("offers the shared file picker for a skin, PNG only", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "read", skin: null } });
        open(true);
        fireEvent.click(
            await screen.findByRole("button", { name: "Drop or paste a skin image here" })
        );
        const dialog = screen.getByRole("dialog", { name: "Shared file picker" });
        expect(dialog.getAttribute("data-accept")).toBe("image/png");
        expect(document.querySelector('input[type="file"]')).toBeNull();
    });

    it("puts a refusal from the server into a sentence", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "read", skin: null } });
        actions.previewSkinAction.mockResolvedValue({ png: PNG, model: "classic", signed: null });
        actions.applySkinAction.mockResolvedValue({ live: { state: "refused", why: "notStaged" } });
        open(true);
        await screen.findByText("Their account's own skin");
        fireEvent.change(screen.getByPlaceholderText("Username or link"), {
            target: { value: "player-two" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Load" }));
        fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
        expect((await screen.findByRole("alert")).textContent).toContain(
            "The server lost the skin before it went on. Apply it again."
        );
    });

    it("says the mod is too old and offers the restart that updates it", async () => {
        actions.readSkinAction.mockResolvedValue({ live: { state: "unsupported" } });
        open(true, true);
        expect(await screen.findByText(/older than skins/)).toBeTruthy();
        expect(screen.getByText("planner: Skins need the newer Polaris mod")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
    });
});
