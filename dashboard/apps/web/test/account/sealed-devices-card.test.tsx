// @vitest-environment jsdom
/**
 * The encrypted-chat devices on /account/sessions: every device listed with
 * when it was added and last used, this browser marked and never offered a
 * Remove, a Remove that says to end the session too, and the row back when the
 * server refuses.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const calls = vi.hoisted(() => ({
    removed: [] as string[],
    answer: {} as { error?: string },
    asked: [] as { description: string }[],
    current: null as string | null
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/components/confirm-dialog", () => ({
    useConfirm: () => [
        async (options: { description: string }) => {
            calls.asked.push(options);
            return true;
        },
        null
    ]
}));
vi.mock("@/components/relative-time", () => ({ RelativeTime: ({ iso }: { iso: string }) => `at:${iso}` }));
vi.mock("@/lib/chat/e2ee/mls-browser", () => ({ existingBrowserDeviceId: () => calls.current }));
vi.mock("../../src/app/(app)/account/sessions/actions", () => ({
    removeSealedDeviceAction: async (device: string) => {
        calls.removed.push(device);
        return calls.answer;
    }
}));

const { SealedDevicesCard } = await import("../../src/app/(app)/account/sessions/sealed-devices-card");

const USER = "11111111-1111-4111-8111-111111111111";
const rows = [
    { device: "aaaaaaaa11112222", createdAt: "2026-11-01T10:00:00.000Z", lastSeenAt: "2026-11-25T10:00:00.000Z" },
    { device: "bbbbbbbb33334444", createdAt: "2026-10-01T10:00:00.000Z", lastSeenAt: "2026-10-02T10:00:00.000Z" }
];

async function show() {
    render(withMessages(<SealedDevicesCard userId={USER} devices={rows} />));
    // The id is read after paint (a dynamic import).
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

beforeEach(() => {
    calls.removed = [];
    calls.answer = {};
    calls.asked = [];
    calls.current = "aaaaaaaa11112222";
});
afterEach(cleanup);

describe("the encrypted-chat devices card", () => {
    it("lists each device by its code with when it was added and last used, and marks this browser", async () => {
        await show();
        expect(screen.getByText("Device aaaaaaaa")).toBeTruthy();
        expect(screen.getByText("Device bbbbbbbb")).toBeTruthy();
        expect(document.body.textContent).toContain("at:2026-10-01T10:00:00.000Z");
        expect(document.body.textContent).toContain("at:2026-10-02T10:00:00.000Z");
        expect(screen.getByText("This browser")).toBeTruthy();
        // This browser's own row has no Remove; the other one does.
        expect(screen.queryByLabelText("Remove device aaaaaaaa from encrypted chats")).toBeNull();
        expect(screen.getByLabelText("Remove device bbbbbbbb from encrypted chats")).toBeTruthy();
    });

    it("offers Remove on every row when this browser has no device", async () => {
        calls.current = null;
        await show();
        expect(screen.queryByText("This browser")).toBeNull();
        expect(screen.getAllByLabelText(/^Remove device /)).toHaveLength(2);
    });

    it("removes after a confirmation that says to end the session too", async () => {
        await show();
        await act(async () => {
            fireEvent.click(screen.getByLabelText("Remove device bbbbbbbb from encrypted chats"));
        });
        expect(calls.asked[0]?.description).toContain("end its session");
        expect(calls.removed).toEqual(["bbbbbbbb33334444"]);
        expect(screen.queryByText("Device bbbbbbbb")).toBeNull();
    });

    it("puts the row back and says why when the server refuses", async () => {
        calls.answer = { error: "That device is no longer listed. Reload the page." };
        await show();
        await act(async () => {
            fireEvent.click(screen.getByLabelText("Remove device bbbbbbbb from encrypted chats"));
        });
        expect(screen.getByText("Device bbbbbbbb")).toBeTruthy();
        expect(screen.getByRole("alert").textContent).toContain("no longer listed");
    });
});
