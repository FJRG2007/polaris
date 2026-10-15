// @vitest-environment jsdom

/**
 * The Limits screen: every dimension is labelled before the usage arrives, with a
 * skeleton only where the numbers go; once read, each row says what is in use
 * against its cap. An administrator of this Polaris gets a field per row and a
 * Save that stays off until something changed; anybody else reads the same rows
 * with no fields, and is told who can change them.
 */

import { MessagesWrapper } from "../../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const ORG = "00000000-0000-7000-8000-0000000000cc";

const state = vi.hoisted(() => ({
    saved: [] as unknown[],
    /** Held open so a test can look at the screen before the usage arrives. */
    release: null as null | (() => void)
}));

const view = {
    limits: { members: 5, teams: null, projects: 2, services: null, databases: null, cpus: null, memoryMb: null },
    usage: { members: 3, teams: 1, projects: 2, services: 4, databases: 0, cpus: 1.5, memoryMb: 512 }
};

vi.mock("@/app/(app)/account/organizations/[slug]/limits/actions", () => ({
    loadOrgQuotaAction: () =>
        new Promise((resolve) => {
            state.release = () => resolve({ view });
        }),
    saveOrgQuotaAction: async (_orgId: string, drafts: unknown) => {
        state.saved.push(drafts);
        return { limits: { ...view.limits, teams: 3 } };
    }
}));

const { LimitsView } = await import("@/app/(app)/account/organizations/[slug]/limits/limits-view");

beforeEach(() => {
    state.saved = [];
    state.release = null;
    sessionStorage.clear();
});
afterEach(cleanup);

async function loaded(): Promise<void> {
    await waitFor(() => expect(state.release).not.toBeNull());
    state.release?.();
    await screen.findByText("2 of 2");
}

describe("the Limits screen", () => {
    it("labels every row at once, with a skeleton only where the usage goes", () => {
        render(<LimitsView orgId={ORG} canEdit={false} />, { wrapper: MessagesWrapper });
        expect(screen.getByRole("list").getAttribute("aria-busy")).toBe("true");
        expect(screen.getAllByRole("listitem")).toHaveLength(7);
        expect(screen.queryByRole("progressbar")).toBeNull();
    });

    it("shows usage against each cap, and no cap where none was set", async () => {
        render(<LimitsView orgId={ORG} canEdit={false} />, { wrapper: MessagesWrapper });
        await loaded();
        expect(screen.getByText("3 of 5")).toBeTruthy();
        expect(screen.getAllByText(/No limit/).length).toBeGreaterThan(0);
        // Only the capped rows draw a bar.
        expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    });

    it("gives somebody who cannot change the caps no fields, and says who can", async () => {
        render(<LimitsView orgId={ORG} canEdit={false} />, { wrapper: MessagesWrapper });
        await loaded();
        expect(screen.queryByRole("textbox")).toBeNull();
        expect(screen.queryByRole("button", { name: "Save limits" })).toBeNull();
        expect(screen.getByText("Only an administrator of this Polaris can change these limits.")).toBeTruthy();
    });

    it("gives an administrator a field per row and a Save that waits for a change", async () => {
        const user = userEvent.setup();
        render(<LimitsView orgId={ORG} canEdit />, { wrapper: MessagesWrapper });
        await loaded();
        const fields = screen.getAllByRole("textbox");
        expect(fields).toHaveLength(7);
        const save = screen.getByRole("button", { name: "Save limits" }) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        await user.type(fields[1]!, "3");
        expect(save.disabled).toBe(false);
        await user.click(save);
        await waitFor(() => expect(state.saved).toHaveLength(1));
        expect(state.saved[0]).toMatchObject({ teams: "3", projects: "2" });
    });
});
