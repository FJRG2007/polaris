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
let pollAnswer: {
    error?: string;
    waiting?: boolean;
    next?: { state: Record<string, string>; summary: string; skippable: boolean };
    devices?: unknown[];
    accounts?: unknown[];
    unsupported?: string[];
} = {};

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
    vi.unstubAllGlobals();
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
    fireEvent.click(choice(/^Philips account/));
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

    it("names a model it cannot fully operate yet before it closes", async () => {
        const onConnected = drawn();
        fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
            target: { value: "owner@example.com" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
        const box = await screen.findByRole("textbox", { name: "Code from the email" });
        pollAnswer = { devices: [{ id: "d1" }], accounts: [], unsupported: ["AC2959/10"] };
        fireEvent.change(box, { target: { value: "123456" } });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        const notice = await screen.findByRole("status");
        expect(notice.textContent).toBe(
            "Connected. This model is not supported yet (AC2959/10): listed with power and what it reports, but modes cannot be set from Polaris yet."
        );
        expect(onConnected).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "Done" }));
        expect(onConnected).toHaveBeenCalledWith({ devices: [{ id: "d1" }], accounts: [] });
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

describe("the Philips Air+ app step", () => {
    /** Through the code to the step that asks for the app. */
    async function toFileStep(skippable = false) {
        const onConnected = drawn();
        fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
            target: { value: "owner@example.com" }
        });
        fireEvent.click(screen.getByRole("button", { name: "Email me a code" }));
        const box = await screen.findByRole("textbox", { name: "Code from the email" });
        pollAnswer = {
            waiting: true,
            next: {
                state: { ticket: "handle-1" },
                summary: "Air+: 0; HomeID: 0; HomeID app: HTTP 500",
                skippable
            }
        };
        fireEvent.change(box, { target: { value: "123456" } });
        fireEvent.click(screen.getByRole("button", { name: "Connect" }));
        await screen.findByText("Upload the Philips Air+ app file (.apk)");
        return onConnected;
    }

    it("says why the app is needed, with what each list held, and where to get it", async () => {
        await toFileStep();
        expect(screen.getByText(/Air\+: 0; HomeID: 0; HomeID app: HTTP 500/)).toBeTruthy();
        expect(screen.getByText(/keeps it encrypted with this connection/)).toBeTruthy();
        const link = screen.getByRole("link", { name: "APKMirror" });
        expect(link.getAttribute("href")).toBe(
            "https://www.apkmirror.com/apk/versuni-netherlands-b-v/philips-air/"
        );
        expect(link.getAttribute("rel")).toBe("noopener noreferrer");
        // The code box is gone, and there is nothing to skip to.
        expect(screen.queryByRole("textbox", { name: "Code from the email" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Connect without it" })).toBeNull();
    });

    it("refuses a file that is not an app before sending it", async () => {
        await toFileStep();
        const input = screen.getByLabelText("Philips Air+ app file");
        fireEvent.change(input, {
            target: { files: [new File(["x"], "photo.jpg", { type: "image/jpeg" })] }
        });
        expect(screen.getByText("Choose an .apk, .apkm, .xapk file.")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Upload" }).getAttribute("aria-disabled")).toBe(
            "true"
        );
    });

    it("streams the app to the server and connects with the handle it answers", async () => {
        const uploads: { url: string; init: RequestInit }[] = [];
        vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
            uploads.push({ url, init });
            return new Response(JSON.stringify({ state: { appSecret: "handle-2" } }), {
                status: 200
            });
        });
        const onConnected = await toFileStep();
        const file = new File(["PK"], "philips-air.apkm");
        fireEvent.change(screen.getByLabelText("Philips Air+ app file"), {
            target: { files: [file] }
        });
        pollAnswer = { devices: [{ id: "am:d1" }], accounts: [] };
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));
        await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
        expect(uploads[0]!.url).toBe("/api/home/pairing/file?connection=philips-cloud");
        expect(uploads[0]!.init.body).toBe(file);
        expect(polled.at(-1)!.state).toEqual({ ticket: "handle-1", appSecret: "handle-2" });
    });

    it("shows the server's refusal and stays on the step", async () => {
        vi.stubGlobal(
            "fetch",
            async () =>
                new Response(JSON.stringify({ error: "That file is not an app file." }), {
                    status: 422
                })
        );
        await toFileStep();
        fireEvent.change(screen.getByLabelText("Philips Air+ app file"), {
            target: { files: [new File(["x"], "other.apk")] }
        });
        fireEvent.click(screen.getByRole("button", { name: "Upload" }));
        expect((await screen.findByRole("alert")).textContent).toBe(
            "That file is not an app file."
        );
        expect(screen.getByText("Upload the Philips Air+ app file (.apk)")).toBeTruthy();
    });

    it("goes on without the app where something was already found", async () => {
        const onConnected = await toFileStep(true);
        pollAnswer = { devices: [{ id: "ext-3" }], accounts: [] };
        fireEvent.click(screen.getByRole("button", { name: "Connect without it" }));
        await waitFor(() => expect(onConnected).toHaveBeenCalledTimes(1));
        expect(polled.at(-1)!.state).toEqual({ ticket: "handle-1", skip: "1" });
    });
});
