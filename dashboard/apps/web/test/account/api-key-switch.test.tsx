// @vitest-environment jsdom
/**
 * The on/off switch on each API key: it flips at once, and goes back when the
 * server refuses.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ApiKeyView } from "@polaris/auth";

let answer: (result: { error?: string }) => void = () => undefined;
const toggleApiKeyAction = vi.fn(
    (_input: unknown) => new Promise<{ error?: string }>((resolve) => (answer = resolve))
);
const refresh = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));
vi.mock("../../src/app/(app)/account/api-keys/actions", () => ({
    toggleApiKeyAction,
    revokeApiKeyAction: vi.fn(),
    deleteApiKeyAction: vi.fn()
}));

const { ApiKeysView } = await import("../../src/app/(app)/account/api-keys/api-keys-view");

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
    return {
        id: "0190a3c2-7a3e-7000-8000-000000000001",
        name: "deploy-bot",
        description: "",
        prefix: "plk_abcdefgh",
        environment: "production",
        tail: "um90",
        scopes: ["tasks.read"],
        allowedCidrs: [],
        allowedCountries: [],
        allowedContinents: [],
        allowedUserAgents: [],
        deniedUserAgents: [],
        groupIds: [],
        expiresAt: null,
        lastUsedAt: null,
        lastUsedIp: null,
        lastUsedUserAgent: null,
        revokedAt: null,
        enabled: true,
        createdAt: "2026-10-01T00:00:00.000Z",
        projectId: null,
        projectName: null,
        kind: "key",
        usedToday: 0,
        usedRecently: 0,
        ...overrides
    };
}

function open(keys: ApiKeyView[]) {
    render(
        <MessagesWrapper>
            <ApiKeysView keys={keys} />
        </MessagesWrapper>
    );
}

beforeEach(() => {
    toggleApiKeyAction.mockClear();
    refresh.mockClear();
});
afterEach(cleanup);

describe("an API key's switch", () => {
    it("switches off at once and tells the server", async () => {
        open([key()]);
        const toggle = screen.getByRole("switch", { name: "Accept calls made with deploy-bot" });
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(toggleApiKeyAction).toHaveBeenCalledWith({
            id: "0190a3c2-7a3e-7000-8000-000000000001",
            enabled: false
        });
        expect(screen.getByText("Switched off")).toBeTruthy();
        answer({});
        await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it("goes back when the server refuses", async () => {
        open([key()]);
        const toggle = screen.getByRole("switch", { name: "Accept calls made with deploy-bot" });
        fireEvent.click(toggle);
        answer({ error: "That key is gone or revoked, so it cannot be switched." });
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
        expect(
            await screen.findByText("That key is gone or revoked, so it cannot be switched.")
        ).toBeTruthy();
        expect(refresh).not.toHaveBeenCalled();
    });

    it("is not offered on a revoked key", () => {
        open([key({ revokedAt: "2026-10-02T00:00:00.000Z" })]);
        expect(screen.queryByRole("switch")).toBeNull();
    });
});
