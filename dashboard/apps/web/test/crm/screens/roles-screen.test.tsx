// @vitest-environment jsdom

/**
 * The roles screen: somebody who does not manage the organization's roles is
 * told so; somebody who does picks a role, hides a field and narrows it to
 * its own records, and Save sends only what changed.
 */

import "@/components/app-host/client";
import { MessagesWrapper } from "../../setup/i18n";
import { OPEN_RULES } from "@polaris-app/crm/src/model/roles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const state = vi.hoisted(() => ({ manage: true, saved: [] as unknown[] }));

vi.mock("@polaris-app/crm/src/actions/roles", () => ({
    rolesAction: async () => ({
        ok: true,
        orgName: "Example Org",
        reading: state.manage
            ? {
                  roles: [
                      { slug: "admin", name: "Admin", full: true, rules: OPEN_RULES },
                      { slug: "sales", name: "Sales", full: false, rules: OPEN_RULES }
                  ],
                  fields: { companies: [], people: [], opportunities: [] }
              }
            : null
    }),
    saveRoleRuleAction: async (input: { rows: string; hidden: string[]; readOnly: string[] }) => {
        state.saved.push(input);
        return { ok: true, rule: { rows: input.rows, hidden: input.hidden, readOnly: input.readOnly } };
    }
}));

import { RolesScreen } from "@polaris-app/crm/src/screens/roles-screen";

beforeEach(() => {
    state.manage = true;
    state.saved = [];
    if (typeof sessionStorage !== "undefined") sessionStorage.clear();
    if (typeof localStorage !== "undefined") localStorage.clear();
});

afterEach(cleanup);

describe("roles screen", () => {
    it("tells a reader who does not manage roles why there is nothing to change", async () => {
        state.manage = false;
        render(<RolesScreen />, { wrapper: MessagesWrapper });
        expect(
            await screen.findByText("Only people who manage the organization's roles can change these.")
        ).toBeTruthy();
    });

    it("saves a hidden field and own-records rule for the first role that rules apply to", async () => {
        render(<RolesScreen />, { wrapper: MessagesWrapper });
        const save = (await screen.findByRole("button", { name: "Save" })) as HTMLButtonElement;
        expect(save.disabled).toBe(true);
        expect(screen.getByText("The name is always shown.")).toBeTruthy();
        fireEvent.click(screen.getByRole("radio", { name: "Only their own" }));
        const employees = screen.getByRole("radiogroup", { name: "Access: Employees" });
        fireEvent.click(employees.querySelector('[value="hidden"]') ?? employees.children[2]!);
        expect(save.disabled).toBe(false);
        await act(async () => {
            fireEvent.click(save);
        });
        expect(state.saved).toEqual([
            { role: "sales", object: "companies", rows: "own", hidden: ["employees"], readOnly: [] }
        ]);
        expect(save.disabled).toBe(true);
    });
});
