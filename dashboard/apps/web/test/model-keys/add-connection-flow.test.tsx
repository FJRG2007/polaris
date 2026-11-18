// @vitest-environment jsdom
/**
 * The AI keys screen's one way in: Add connection lists a provider's plan and key
 * together, and the way picked opens the dialog that already handled it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderRow } from "@/lib/agents/model-key-providers";
import type { ProviderReader } from "@/components/model-keys/provider-select";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/(app)/account/ai-keys/login-actions", () => ({
    finishGitlabLoginAction: vi.fn(),
    goUsageAction: async () => [],
    pollProviderLoginAction: vi.fn(),
    startProviderLoginAction: vi.fn(async () => new Promise(() => undefined))
}));
vi.mock("@/app/(app)/account/ai-keys/cloud-actions", () => ({}));

const { ModelKeysView } = await import("@/components/model-keys/model-keys-view");
const { ConnectionHub } = await import("@/components/model-keys/connection-hub");
const { ProviderLogins } = await import("@/components/model-keys/provider-logins");
const { CloudAccounts } = await import("@/components/model-keys/cloud-accounts");

const XAI: ProviderRow = {
    slug: "xai",
    name: "xAI",
    aliases: [],
    apiKeyLabel: "API key",
    apiKeyHelp: null,
    createUrl: null,
    isGateway: false,
    checkable: true,
    freeTier: null
};

const actions = {
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(async () => ({})),
    reorder: vi.fn(async () => ({}))
};

function open(searchProviders: ProviderReader = async () => ({ items: [XAI], next: null })) {
    render(
        <MessagesWrapper>
            <ConnectionHub>
                <ProviderLogins />
                <CloudAccounts />
                <ModelKeysView
                    providers={[XAI]}
                    searchProviders={searchProviders}
                    keys={[]}
                    actions={actions}
                    copy={{ title: "Connections", hint: "", empty: "None", adding: "" }}
                />
            </ConnectionHub>
        </MessagesWrapper>
    );
}

afterEach(cleanup);

describe("Add connection", () => {
    it("replaces the sign-in and cloud cards with one button", () => {
        open();
        expect(screen.queryByText("Sign in with a subscription")).toBeNull();
        expect(screen.queryByText("Cloud accounts")).toBeNull();
        expect(screen.getByRole("button", { name: "Add connection" })).toBeTruthy();
    });

    it("offers xAI's plan and key together, and opens the key dialog on xAI", async () => {
        open();
        fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
        fireEvent.click(await screen.findByRole("button", { name: /xAI/ }));

        expect(await screen.findByText("Sign in with SuperGrok")).toBeTruthy();
        fireEvent.click(screen.getByText("xAI API key"));
        fireEvent.click(screen.getByRole("button", { name: "Continue" }));

        expect(screen.queryByText("Connect xAI")).toBeNull();
        expect(await screen.findAllByText(/xAI/)).not.toHaveLength(0);
        expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("opens a cloud account straight away, as its only way in", async () => {
        open();
        fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
        fireEvent.click(await screen.findByRole("button", { name: /Amazon Bedrock/ }));
        expect(await screen.findByText("Add Amazon Bedrock")).toBeTruthy();
        expect(screen.getByText("Access key ID", { exact: false })).toBeTruthy();
    });

    it("paints the plans and clouds before the provider catalogue answers", () => {
        open(() => new Promise(() => undefined));
        fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
        expect(screen.getByRole("button", { name: /Amazon Bedrock/ })).toBeTruthy();
        expect(screen.getByLabelText("Loading providers...")).toBeTruthy();
    });

    it("asks the server once typing settles, not once per keystroke", async () => {
        vi.useFakeTimers();
        try {
            const read = vi.fn<ProviderReader>(async () => ({ items: [XAI], next: null }));
            open(read);
            fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
            read.mockClear();
            const field = screen.getByRole("searchbox", { name: "Search providers, clouds and agents" });
            for (const text of ["g", "gr", "gro", "grok"]) fireEvent.change(field, { target: { value: text } });
            await act(async () => {
                await vi.advanceTimersByTimeAsync(300);
            });
            expect(read).toHaveBeenCalledTimes(1);
            expect(read.mock.calls[0]![0]).toMatchObject({ query: "grok" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("narrows the catalogue to a category", () => {
        open(() => new Promise(() => undefined));
        fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
        fireEvent.click(screen.getByRole("radio", { name: "Clouds" }));
        expect(screen.getByRole("button", { name: /Amazon Bedrock/ })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /SuperGrok|^xAI/ })).toBeNull();
    });
});
