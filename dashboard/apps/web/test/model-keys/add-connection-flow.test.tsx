// @vitest-environment jsdom
/**
 * The AI keys screen's one way in: Add connection lists a provider's plan and key
 * together, and the way picked opens the dialog that already handled it.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ProviderRow } from "@/lib/agents/model-key-providers";

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

function open() {
    render(
        <MessagesWrapper>
            <ConnectionHub>
                <ProviderLogins />
                <CloudAccounts />
                <ModelKeysView
                    providers={[XAI]}
                    searchProviders={async () => ({ items: [XAI], next: null })}
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
});
