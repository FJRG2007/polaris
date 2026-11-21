// @vitest-environment jsdom

/**
 * One invite, three readers. The player it lets in is told to join as
 * themselves; whoever sent it, and anybody else who may read the server, is
 * told who it is for, in words about that player rather than to them. The page
 * link appears only for a reader who may open the page, and every line is in
 * the reader's own language.
 */

import { withMessages } from "../../setup/i18n";
import type { ChatMessageView } from "@/lib/chat/messages";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const SERVER = "aaaaaaaa-1111-4111-8111-111111111111";
let reading: { forPlayer: boolean; canOpen: boolean; release: string | null } = {
    forPlayer: true,
    canOpen: false,
    release: "1.20.1"
};

vi.mock("@/app/(app)/chat/game-server-card-actions", () => ({
    readGameInviteCard: async (id: string, player: string) => ({
        state: "ready",
        id,
        name: "cursed",
        game: "minecraft",
        guide: "minecraftJava",
        address: "cursed.mc.example.test",
        joinLink: null,
        href: `/game-servers/${id}`,
        running: true,
        player,
        joinFrom: { kind: "signIns" },
        ...reading
    })
}));

const { GameInviteCard } = await import("@/app/(app)/chat/game-server-card");

afterEach(cleanup);

const MESSAGE = {
    id: "m1",
    authorId: "sender",
    authorName: "Owner",
    createdAt: new Date(0).toISOString()
} as unknown as ChatMessageView;

function show(mine: boolean, locale: "en-US" | "es-ES" = "en-US") {
    render(
        withMessages(
            <GameInviteCard
                invite={{ installedAppId: SERVER, player: "Reckmy" }}
                message={MESSAGE}
                mine={mine}
            />,
            locale
        )
    );
}

describe("an invite card", () => {
    it("speaks to the invited player, without the page they cannot open", async () => {
        reading = { forPlayer: true, canOpen: false, release: "1.20.1" };
        show(false);
        expect(await screen.findByText("Join as Reckmy")).toBeTruthy();
        expect(screen.getByText("From wherever you are signed in to Polaris")).toBeTruthy();
        expect(screen.queryByText("Open server page")).toBeNull();
    });

    it("tells whoever sent it who it is for, with the page they may open", async () => {
        reading = { forPlayer: false, canOpen: true, release: "1.20.1" };
        show(true);
        expect(await screen.findByText("Invite for Reckmy")).toBeTruthy();
        expect(screen.queryByText("Join as Reckmy")).toBeNull();
        expect(screen.getByText("From wherever they are signed in to Polaris")).toBeTruthy();
        expect(screen.getByText("Open server page")).toBeTruthy();
    });

    it("is in the reader's own language", async () => {
        reading = { forPlayer: false, canOpen: true, release: "1.20.1" };
        show(true, "es-ES");
        expect(await screen.findByText("Invitación para Reckmy")).toBeTruthy();
        expect(screen.getByText("Abrir el servidor")).toBeTruthy();
    });

    it("leaves the release out of the guide when the server does not report one", async () => {
        reading = { forPlayer: true, canOpen: false, release: null };
        show(false);
        await screen.findByText("Join as Reckmy");
        expect(screen.getByText(/1\. Open Minecraft Java Edition\. 2\./)).toBeTruthy();
        expect(screen.queryByText(/Edition -/)).toBeNull();
    });
});
