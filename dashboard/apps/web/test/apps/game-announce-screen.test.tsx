// @vitest-environment jsdom

/**
 * The Announce screen, used the way an operator would: write a title, see it on
 * the game screen, and send exactly what was previewed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const sent: unknown[] = [];

vi.mock("@polaris/app-host/client", () => ({
    hostUi: {
        confirmDialog: { useConfirm: () => [async () => true, null] },
        copyButton: { CopyButton: () => null }
    }
}));
vi.mock("@polaris-app/game-servers/src/screens/installed/announce-actions", () => ({
    listAnnouncementTemplatesAction: async () => ({
        templates: [
            {
                id: "t1",
                name: "Restart warning",
                announcement: {
                    target: "@a",
                    title: "&c&lRestarting",
                    subtitle: "",
                    actionbar: "",
                    chat: "",
                    tagged: true,
                    fadeIn: 0.5,
                    stay: 3.5,
                    fadeOut: 1,
                    sound: ""
                }
            }
        ]
    }),
    sendAnnouncementAction: async (input: unknown) => {
        sent.push(input);
        return { sent: 2 };
    },
    saveAnnouncementTemplateAction: async () => ({ templates: [] }),
    deleteAnnouncementTemplateAction: async () => ({ templates: [] })
}));

const { MinecraftAnnounce } = await import(
    "@polaris-app/game-servers/src/screens/installed/minecraft-announce"
);

afterEach(() => {
    cleanup();
    sent.length = 0;
});

describe("the Announce screen", () => {
    it("previews what is typed and sends that", async () => {
        render(
            <MinecraftAnnounce installedAppId="s1" running edition="java" players={["ErMigue04"]} />
        );
        fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Server restart" } });

        const preview = screen.getByLabelText("Preview of the announcement in the game");
        expect(preview.textContent).toContain("Server restart");
        expect(screen.getByText(/^title @a title /).textContent).toContain(
            '"text":"Server restart"'
        );

        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: /^Send$/ }));
        });
        await waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({
            installedAppId: "s1",
            announcement: { target: "@a", title: "Server restart" }
        });
        expect(await screen.findByText("Sent to everybody on the server.")).toBeTruthy();
    });

    it("loads a template into the fields and the preview", async () => {
        render(<MinecraftAnnounce installedAppId="s1" running edition="java" players={[]} />);
        fireEvent.click(await screen.findByText("Restart warning"));
        const preview = screen.getByLabelText("Preview of the announcement in the game");
        expect(preview.textContent).toContain("Restarting");
        expect((screen.getByLabelText("Title") as HTMLTextAreaElement).value).toBe("Restarting");
    });

    it("will not send while the server is stopped, or with nothing written", () => {
        render(
            <MinecraftAnnounce installedAppId="s1" running={false} edition="java" players={[]} />
        );
        expect((screen.getByRole("button", { name: /^Send$/ }) as HTMLButtonElement).disabled).toBe(
            true
        );
        expect(screen.getByText("Start the server to send it.")).toBeTruthy();
    });
});
