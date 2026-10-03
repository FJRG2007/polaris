// @vitest-environment jsdom

/**
 * The Settings tab's shared shape: a section with its heading, a card holding a
 * Save that is blocked until the card actually differs from what is stored, and
 * "Saved" once it does. Mounts the real `settings-kit.tsx` pieces the way every
 * tab of the panel uses them - there is no browser or Docker host available here
 * to drive a real page render against, so this is the rendered evidence.
 */

import { Network } from "lucide-react";
import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SaveBar, SettingsCard, SettingsLayout, SettingsSection, useCardForm } from "@/app/(app)/apps/deploy/settings-kit";

afterEach(cleanup);

function NetworkingCard() {
    const form = useCardForm({ port: "3000" });
    return (
        <SettingsLayout sections={[{ id: "networking", label: "Networking", icon: Network }]}>
            <SettingsSection id="networking" icon={Network} title="Networking" intro="Where the service answers.">
                <SettingsCard
                    title="Port"
                    description="The port the container listens on."
                    footer={
                        <SaveBar
                            dirty={form.dirty()}
                            pending={false}
                            justSaved={form.justSaved()}
                            onSave={() => form.commit(form.next())}
                        />
                    }
                >
                    <input aria-label="Port" value={form.draft.port} onChange={(event) => form.patch({ port: event.target.value })} />
                </SettingsCard>
            </SettingsSection>
        </SettingsLayout>
    );
}

describe("the Settings tab's shared section and card shape", () => {
    it("draws a titled section holding a card with its own Save", () => {
        render(<NetworkingCard />, { wrapper: MessagesWrapper });

        expect(screen.getByRole("heading", { name: "Networking" })).toBeDefined();
        expect(screen.getByText("Port")).toBeDefined();
        expect(screen.getByRole("button", { name: "Networking" }).getAttribute("aria-current")).toBe("true");
    });

    it("blocks Save until the card actually differs from what is stored", () => {
        render(<NetworkingCard />, { wrapper: MessagesWrapper });
        const save = screen.getByRole("button", { name: "Save" });
        const port = screen.getByLabelText("Port");

        expect(save.getAttribute("aria-disabled")).toBe("true");

        fireEvent.change(port, { target: { value: "8080" } });
        expect(save.getAttribute("aria-disabled")).toBe("false");
        expect(screen.getByText("Unsaved changes")).toBeDefined();

        // Typed back to the stored value: not a change, so Save blocks again.
        fireEvent.change(port, { target: { value: "3000" } });
        expect(save.getAttribute("aria-disabled")).toBe("true");
    });

    it("confirms the save in place once a real edit is committed", () => {
        render(<NetworkingCard />, { wrapper: MessagesWrapper });
        const save = screen.getByRole("button", { name: "Save" });
        const port = screen.getByLabelText("Port");

        fireEvent.change(port, { target: { value: "8080" } });
        fireEvent.click(save);

        expect(screen.getByText("Saved")).toBeDefined();
        expect(save.getAttribute("aria-disabled")).toBe("true");
    });
});
