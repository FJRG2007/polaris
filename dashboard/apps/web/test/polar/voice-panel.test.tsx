// @vitest-environment jsdom
/**
 * The voice buttons in Polar's composer: without a voice provider they stay in
 * place and, pressed, name what to connect with the way to connect it; with
 * one, voice mode opens over the same thread.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@ai-sdk/react", () => ({
    useChat: () => ({
        status: "ready",
        messages: [],
        error: undefined,
        sendMessage: async () => undefined,
        stop: async () => undefined,
        setMessages: () => undefined,
        regenerate: async () => undefined,
        addToolApprovalResponse: async () => undefined
    })
}));
vi.mock("next/navigation", () => ({
    usePathname: () => "/tasks",
    useRouter: () => ({ push: () => undefined })
}));

const PROVIDERS = [
    {
        provider: "openai",
        name: "OpenAI",
        payers: ["own"],
        models: [{ provider: "openai", model: "m-1", name: "Model One", reasoning: false }]
    }
];

let models: Record<string, unknown> = {};

beforeEach(() => {
    try {
        window.localStorage.clear();
    } catch {
        // No storage in this environment.
    }
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url === "/api/polar/models") return Response.json(models);
            if (url === "/api/polar/threads") return Response.json({ threads: [] });
            return Response.json({});
        })
    );
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

const { PolarChat } = await import("@/components/polar/polar-panel");

const UNAVAILABLE = "Speaking to Polar needs an OpenAI or Google AI key.";

async function ready() {
    await waitFor(() => expect(screen.getByText("Model One", { exact: false })).toBeTruthy());
}

describe("voice in the composer", () => {
    it("names what to connect, with the links, when there is no voice provider", async () => {
        models = {
            providers: PROVIDERS,
            tools: {},
            isAdmin: true,
            voice: { dictation: false, speech: false }
        };
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await ready();
        const buttons = screen.getAllByRole("button", { name: UNAVAILABLE });
        expect(buttons).toHaveLength(2);
        fireEvent.click(buttons[0]!);
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain(UNAVAILABLE);
        expect(screen.getByRole("link", { name: "Add your own key" }).getAttribute("href")).toBe(
            "/account/ai-keys"
        );
        expect(
            screen.getByRole("link", { name: "Manage this Polaris's keys" }).getAttribute("href")
        ).toBe("/admin/integrations/models");
        fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("treats an older server that sends no voice field as no provider", async () => {
        models = { providers: PROVIDERS, tools: {}, isAdmin: false };
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await ready();
        expect(screen.getAllByRole("button", { name: UNAVAILABLE })).toHaveLength(2);
    });

    it("opens voice mode over the thread, and ends it", async () => {
        models = {
            providers: PROVIDERS,
            tools: {},
            isAdmin: false,
            voice: { dictation: true, speech: true }
        };
        vi.stubGlobal(
            "MediaRecorder",
            class {
                static isTypeSupported() {
                    return true;
                }
            }
        );
        Object.defineProperty(navigator, "mediaDevices", {
            configurable: true,
            value: { getUserMedia: vi.fn(async () => Promise.reject(new Error("NotAllowedError"))) }
        });
        render(<PolarChat />, { wrapper: MessagesWrapper });
        await ready();
        expect(screen.getByRole("button", { name: "Dictate" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Voice mode" }));
        expect(await screen.findByRole("dialog", { name: "Voice mode" })).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "End call" }));
        await waitFor(() =>
            expect(screen.queryByRole("dialog", { name: "Voice mode" })).toBeNull()
        );
    });
});
