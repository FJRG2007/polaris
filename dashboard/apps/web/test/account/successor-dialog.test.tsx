// @vitest-environment jsdom
/**
 * The "Add a successor" dialog offers nothing after the search until somebody
 * else has been found: not the confirmation code, not the consent, and the add
 * button says why it is unavailable instead of going through.
 */

import { withMessages } from "../setup/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const lookup = vi.fn();
const setSuccessor = vi.fn(async (_input: unknown) => ({}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("../../src/app/(app)/account/security/successor-actions", () => ({
    lookupSuccessorAction: (term: string) => lookup(term),
    setSuccessorAction: (input: unknown) => setSuccessor(input),
    clearSuccessorAction: async () => ({})
}));
vi.mock("@/components/step-up-fields", () => ({
    StepUpFields: (props: { purpose: string; onChange: (proof: unknown) => void }) => (
        <button
            type="button"
            data-testid="step-up"
            data-purpose={props.purpose}
            onClick={() => props.onChange({ proof: "email", code: "123456" })}
        >
            code
        </button>
    )
}));
vi.mock("@/lib/step-up-proof-client", () => ({ stepUpProofToSend: async (proof: unknown) => proof }));

const { SuccessorCard } = await import("../../src/app/(app)/account/security/successor-card");

function open() {
    render(withMessages(<SuccessorCard successor={null} />));
    fireEvent.click(screen.getByRole("button", { name: /add successor/i }));
}

function type(value: string) {
    fireEvent.change(screen.getByLabelText(/search by username/i), { target: { value } });
}

beforeEach(() => {
    vi.clearAllMocks();
});
afterEach(cleanup);

describe("the add-successor dialog", () => {
    it("offers no code and no consent before anybody is found, and the add button explains", () => {
        open();
        expect(screen.queryByTestId("step-up")).toBeNull();
        expect(screen.queryByText(/you acknowledge that you own this account/i)).toBeNull();
        const add = screen.getAllByRole("button", { name: /add successor/i }).at(-1)!;
        expect(add.getAttribute("aria-disabled")).toBe("true");
        expect(screen.getByText("Pick the person first.")).toBeTruthy();
    });

    it("says that is you for your own address and still offers nothing", async () => {
        lookup.mockResolvedValue({ kind: "self" });
        open();
        type("second@example.test");
        expect(await screen.findByText("That is you. Pick somebody else.")).toBeTruthy();
        expect(screen.queryByTestId("step-up")).toBeNull();
    });

    it("offers nothing when no account matches", async () => {
        lookup.mockResolvedValue({ kind: "none" });
        open();
        type("nobody@example.test");
        expect(await screen.findByText(/No account matches/)).toBeTruthy();
        expect(screen.queryByTestId("step-up")).toBeNull();
        const add = screen.getAllByRole("button", { name: /add successor/i }).at(-1)!;
        fireEvent.click(add);
        expect(setSuccessor).not.toHaveBeenCalled();
    });

    it("shows the person found, then the code, then adds them", async () => {
        lookup.mockResolvedValue({
            kind: "match",
            person: { userId: "user-heir", name: "Ana Garcia", username: "ana" }
        });
        open();
        type("ana");
        expect(await screen.findByText("Ana Garcia")).toBeTruthy();
        const step = await screen.findByTestId("step-up");
        expect(step.getAttribute("data-purpose")).toBe("account-successor-set:user-heir");

        fireEvent.click(step);
        const add = screen.getAllByRole("button", { name: /add successor/i }).at(-1)!;
        await waitFor(() => expect(add.getAttribute("aria-disabled")).toBeNull());
        fireEvent.click(add);
        await waitFor(() => expect(setSuccessor).toHaveBeenCalledOnce());
        expect(setSuccessor.mock.calls[0]![0]).toMatchObject({ identifier: "ana", userId: "user-heir" });
    });

    it("takes the code away again when the text changes to somebody who is not there", async () => {
        lookup.mockResolvedValueOnce({
            kind: "match",
            person: { userId: "user-heir", name: "Ana Garcia", username: "ana" }
        });
        open();
        type("ana");
        await screen.findByTestId("step-up");
        lookup.mockResolvedValue({ kind: "none" });
        type("anaa");
        await waitFor(() => expect(screen.queryByTestId("step-up")).toBeNull());
    });
});
