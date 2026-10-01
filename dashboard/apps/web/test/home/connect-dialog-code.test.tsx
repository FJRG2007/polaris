// @vitest-environment jsdom

/**
 * Connecting by a code the maker emails: the address first, then a box for the
 * code, and the account once the code is right.
 *
 * Drawn with the server actions replaced: what is checked is the dialog - that
 * the unofficial note is on screen before anything is typed, that a wrong code
 * leaves the box there to try again, and that a right one hands back the
 * devices it found.
 */

import "@/components/app-host/client";
import { withMessages } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const started: unknown[] = [];
const polled: { state: Record<string, string> }[] = [];
let pollAnswer: { error?: string; devices?: unknown[]; accounts?: unknown[] } = {};

vi.mock("@polaris-app/places/src/screens/actions", () => ({
    startDevicePairingAction: async (input: unknown) => {
        started.push(input);
        return { state: { vToken: "vt-1" } };
    },
    pollDevicePairingAction: async (input: { state: Record<string, string> }) => {
        polled.push(input);
        return pollAnswer;
    },
    connectDeviceAccountAction: async () => ({}),
    reconnectDeviceAccountAction: async () => ({})
}));

const { ConnectDialog } = await import("@polaris-app/places/src/screens/devices/connect-dialog");

afterEach(() => {
    cleanup();
    started.length = 0;
    polled.length = 0;
    pollAnswer = {};
});

function drawn(onConnected = vi.fn()) {
    render(
        withMessages(
            <ConnectDialog open reconnect={null} onClose={() => {}} onConnected={onConnected} />
        )
    );
    const choice = (pattern: RegExp) =>
        screen
            .getAllByRole("button")
            .find(
                (button) =>
                    button.getAttribute("aria-pressed") !== null &&
                    pattern.test(button.textContent ?? "")
            )!;
    fireEvent.click(choice(/^Philips(?! Hue)/));
    fireEvent.click(choice(/^Philips Air\+ account/));
    return onConnected;
}

describe("a Philips Air+ account", () => {
    it("says it is unofficial before anything is typed", () => {
        drawn();
        expect(screen.getByText(/Unofficial: Philips publishes no API/)).toBeTruthy();
    });

    it("waits for a whole email address before asking for a code", () => {
        drawn();
        const email = screen.getByRole("textbox", { name: "Email" });
        const send = screen.getByRole("button", { name: "Email me a code" });
        expect(send.getAttribute("aria-disabled")).toBe("true");
        fireEvent.change(email, { target: { value: "owner@" } });
        expect(screen.getByText(/Type a whole email address/)).toBeTruthy();
        fireEvent.change(email, { target: { value: "owner@example.com" } });
        expect(send.getAttribute("aria-disabled")).toBe("false");
    });

    it("asks for the code, keeps the box after a wrong one, and connects with a right one", async () => {
        const onConnected = drawn();
        fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
            target: { value: "owner@example.com" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
        const box = await screen.findByRole("textbox", { name: "Code from the email" });
        expect(started).toHaveLength(1);
        expect(screen.getByText(/Philips has emailed a one-time code/)).toBeTruthy();

        pollAnswer = { error: "That code is not right or has expired. Ask for a new one." };
        fireEvent.change(box, { target: { value: "111 111" } });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(polled[0]!.state).toEqual({ vToken: "vt-1", code: "111111" });
        expect(screen.getByRole("textbox", { name: "Code from the email" })).toBeTruthy();

        pollAnswer = { devices: [{ id: "d1" }], accounts: [] };
        fireEvent.change(box, { target: { value: "123456" } });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
        expect(onConnected.mock.calls[0]![0]).toEqual({ devices: [{ id: "d1" }], accounts: [] });
    });

    it("sends a new code on request", async () => {
        drawn();
        fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
            target: { value: "owner@example.com" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
        await screen.findByRole("textbox", { name: "Code from the email" });
        fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
        await waitFor(() => expect(started).toHaveLength(2));
    });
});
