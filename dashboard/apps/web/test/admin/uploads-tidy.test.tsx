// @vitest-environment jsdom

/**
 * Tidying the chat storage is asked about first.
 *
 * What the button runs is a recursive delete of every folder under the chat root
 * that no conversation answers for, on every storage this instance has ever
 * written chat files to - a NAS share among them. Nothing puts it back, so a
 * single press must not be able to start it, and a run where folders refused must
 * not read as a clean sweep.
 */

import { UploadsView } from "@/app/(app)/admin/uploads/uploads-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let runs = 0;
let answer: { removed?: number; failed?: number; error?: string } = { removed: 3, failed: 0 };

vi.mock("@/app/(app)/admin/uploads/actions", () => ({
    checkStorageAction: async () => ({ ok: true, detail: "", where: "" }),
    setAvatarSettingsAction: async () => ({}),
    setChatStorageTargetAction: async () => ({}),
    setFootageTargetAction: async () => ({}),
    setUploadSettingsAction: async () => ({}),
    tidyChatStorageAction: async () => {
        runs += 1;
        return answer;
    }
}));

const target = { id: "local", name: "this server", automatic: true };

function draw() {
    return render(
        <UploadsView
            uploads={{
                choice: "auto",
                resolved: target,
                options: [],
                maxBytes: 25 * 1024 * 1024,
                allowPreviews: true
            }}
            avatars={{ choice: "auto", resolved: target, options: [] }}
            chat={{ choice: "auto", resolved: target, options: [] }}
            footage={null}
        />
    );
}

/** The press on the card, and then the one inside the question. While the dialog
 *  is up it is the only thing in the tree, so both are "the Tidy up button". */
function press(): void {
    fireEvent.click(screen.getByRole("button", { name: "Tidy up" }));
}

beforeEach(() => {
    runs = 0;
    answer = { removed: 3, failed: 0 };
});

afterEach(cleanup);

describe("tidying the chat storage", () => {
    it("does nothing until it is confirmed", async () => {
        draw();
        press();
        // The question is up and says what goes; nothing has run.
        expect(runs).toBe(0);
        expect(screen.getByText(/do not come back/i)).toBeTruthy();

        press();
        expect(await screen.findByText("Took out 3 folders.")).toBeTruthy();
        expect(runs).toBe(1);
    });

    it("says what could not be removed rather than counting only what could", async () => {
        answer = { removed: 2, failed: 4 };
        draw();
        press();
        press();
        expect(await screen.findByText(/4 could not be removed/i)).toBeTruthy();
    });
});
