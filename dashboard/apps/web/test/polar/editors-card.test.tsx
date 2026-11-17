// @vitest-environment jsdom
/**
 * The editor block on Polar's settings follows the server's checks: the
 * heading at once and a skeleton over the block alone while they run, no
 * snippet for an account that may not use Polar, and no "Create a key" for
 * one that cannot hold a key with the Polar permission.
 */

import { MessagesWrapper } from "../setup/i18n";
import { ACP_KEY_PLACEHOLDER } from "@/lib/polar/acp-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = {
    answer: null as null | (() => Promise<{ use: boolean; keys: boolean }>),
    created: [] as unknown[]
};

vi.mock("@/app/(app)/polar/settings/routing-actions", () => ({
    editorSetupAccessAction: () => state.answer!()
}));
vi.mock("@/app/(app)/account/api-keys/actions", () => ({
    createApiKeyAction: async (input: unknown) => {
        state.created.push(input);
        return { secret: "pk_test_made_here_0123456789" };
    }
}));
vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    useToast: () => ({ show: vi.fn() })
}));

const { EditorsCard } = await import("@/app/(app)/polar/settings/polar-editors");

afterEach(() => {
    cleanup();
    state.created = [];
});

describe("EditorsCard", () => {
    it("shows the heading while the check runs, with a skeleton over the block only", async () => {
        let resolve: (value: { use: boolean; keys: boolean }) => void = () => undefined;
        state.answer = () => new Promise((done) => (resolve = done));
        render(<EditorsCard />, { wrapper: MessagesWrapper });
        expect(screen.getByText("Use Polar in your editor")).toBeTruthy();
        expect(screen.getByTestId("editors-skeleton")).toBeTruthy();
        expect(screen.queryByText("Create a key")).toBeNull();
        resolve({ use: true, keys: true });
        await waitFor(() => expect(screen.queryByTestId("editors-skeleton")).toBeNull());
    });

    it("offers the snippet and a key when the account may use Polar and hold its keys", async () => {
        state.answer = async () => ({ use: true, keys: true });
        render(<EditorsCard />, { wrapper: MessagesWrapper });
        const create = await screen.findByText("Create a key");
        expect(document.body.textContent).toContain(ACP_KEY_PLACEHOLDER);
        fireEvent.click(create);
        await waitFor(() => expect(document.body.textContent).toContain("pk_test_made_here_0123456789"));
        expect(state.created).toEqual([{ name: "Polar in an editor", scopes: ["polar.use"] }]);
    });

    it("says why there is nothing to paste when the account may not use Polar", async () => {
        state.answer = async () => ({ use: false, keys: false });
        render(<EditorsCard />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Your account is not allowed to use Polar.")).toBeTruthy();
        expect(document.body.textContent).not.toContain(ACP_KEY_PLACEHOLDER);
        expect(screen.queryByText("Create a key")).toBeNull();
    });

    it("shows the snippet with the placeholder and no key button when Polar keys are not available", async () => {
        state.answer = async () => ({ use: true, keys: false });
        render(<EditorsCard />, { wrapper: MessagesWrapper });
        expect(await screen.findByText("Keys with the Polar permission are not available to your account.")).toBeTruthy();
        expect(document.body.textContent).toContain(ACP_KEY_PLACEHOLDER);
        expect(screen.queryByText("Create a key")).toBeNull();
    });

    it("offers to check again when the check fails", async () => {
        let calls = 0;
        state.answer = async () => {
            calls += 1;
            if (calls === 1) throw new Error("offline");
            return { use: true, keys: true };
        };
        render(<EditorsCard />, { wrapper: MessagesWrapper });
        fireEvent.click(await screen.findByText("Try again"));
        expect(await screen.findByText("Create a key")).toBeTruthy();
    });
});
