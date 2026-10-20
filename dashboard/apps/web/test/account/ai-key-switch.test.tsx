// @vitest-environment jsdom
/**
 * A person's own AI keys: the on/off switch the deployment's keys already had,
 * and the Workspace ID an Anthropic key not tied to one workspace needs.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ModelKeyView } from "@/lib/agents/model-keys";
import type { ProviderRow } from "@/lib/agents/model-key-providers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

const { ModelKeysView } = await import("@/components/model-keys/model-keys-view");

const ANTHROPIC: ProviderRow = {
    slug: "anthropic",
    name: "Anthropic",
    aliases: [],
    apiKeyLabel: "API key",
    apiKeyHelp: null,
    createUrl: null,
    isGateway: false,
    checkable: true,
    freeTier: null
};

const KEY: ModelKeyView = {
    id: "0190a3c2-7a3e-7000-8000-000000000001",
    provider: "anthropic",
    name: "work",
    priority: 0,
    config: {},
    expiresAt: null,
    lastUsedAt: null,
    enabled: true,
    updatedAt: "2026-10-01T00:00:00.000Z"
};

let answer: (result: { error?: string }) => void = () => undefined;
const actions = {
    add: vi.fn(async (_input: unknown) => ({})),
    update: vi.fn(async (_input: unknown) => ({})),
    remove: vi.fn(async () => ({})),
    reorder: vi.fn(async () => ({})),
    toggle: vi.fn((_input: unknown) => new Promise<{ error?: string }>((r) => (answer = r)))
};

function open(keys: ModelKeyView[] = [KEY]) {
    render(
        <MessagesWrapper>
            <ModelKeysView
                providers={[ANTHROPIC]}
                keys={keys}
                actions={actions}
                copy={{ title: "Keys", hint: "", empty: "None", adding: "" }}
            />
        </MessagesWrapper>
    );
}

beforeEach(() => {
    for (const action of Object.values(actions)) action.mockClear();
});
afterEach(cleanup);

describe("a personal AI key's switch", () => {
    it("flips at once and goes back when the server refuses", async () => {
        open();
        const toggle = screen.getByRole("switch", { name: "Let runs use work" });
        fireEvent.click(toggle);
        expect(toggle.getAttribute("aria-checked")).toBe("false");
        expect(actions.toggle).toHaveBeenCalledWith({ id: KEY.id, enabled: false });
        answer({ error: "That key is gone." });
        await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
        expect(await screen.findByText("That key is gone.")).toBeTruthy();
    });
});

describe("the Workspace ID field", () => {
    it("is offered on an Anthropic key and sent with the edit", async () => {
        open();
        fireEvent.click(screen.getByRole("button", { name: "Edit work" }));
        const field = await screen.findByPlaceholderText("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ");
        fireEvent.change(field, { target: { value: "not-a-workspace" } });
        expect(screen.getByText(/A workspace ID starts with wrkspc_/)).toBeTruthy();
        fireEvent.change(field, { target: { value: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(actions.update).toHaveBeenCalledWith(
                expect.objectContaining({ workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" })
            )
        );
    });

    it("clears a stored workspace when the field is emptied", async () => {
        open([{ ...KEY, config: { workspaceId: "wrkspc_01abc" } }]);
        fireEvent.click(screen.getByRole("button", { name: "Edit work" }));
        const field = await screen.findByDisplayValue("wrkspc_01abc");
        fireEvent.change(field, { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() =>
            expect(actions.update).toHaveBeenCalledWith(
                expect.objectContaining({ workspaceId: null })
            )
        );
    });

    it("appears on a new key once Anthropic says the key needs one", async () => {
        actions.add.mockResolvedValueOnce({
            error: "This key needs the ID of the Anthropic workspace to use. Add it under Workspace ID.",
            needsWorkspace: true
        } as never);
        open([]);
        fireEvent.click(screen.getByRole("button", { name: "Add key" }));
        expect(screen.queryByPlaceholderText("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ")).toBeNull();
        fireEvent.change(screen.getByPlaceholderText("e.g. prod-main"), {
            target: { value: "work" }
        });
        fireEvent.change(screen.getByLabelText(/API key/), {
            target: { value: "sk-ant-api03-abcdefgh" }
        });
        const buttons = screen.getAllByRole("button", { name: "Add key" });
        fireEvent.click(buttons[buttons.length - 1]!);
        expect(await screen.findByPlaceholderText("wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ")).toBeTruthy();
    });
});
