// @vitest-environment jsdom

/**
 * The filters screen as somebody uses it.
 *
 * A filter saved the old way opens in the automation editor as one condition
 * and saves back in place; a second condition can join it, all or any; the
 * list shows a change at once and puts it back when the server refuses it; and
 * deleting asks first, in Polaris' own dialog.
 */

import * as core from "@polaris/core";
import { ToastProvider } from "@polaris/ui";
import { MessagesWrapper } from "../../setup/i18n";
import type { MailRuleView } from "@/lib/mailbox/rules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
    useSearchParams: () => new URLSearchParams()
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));

const saveRuleAction = vi.fn(
    async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ id: "r1" })
);
const setRuleEnabledAction = vi.fn(
    async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})
);
const deleteRuleAction = vi.fn(
    async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})
);
const reorderRulesAction = vi.fn(
    async (..._args: unknown[]): Promise<Record<string, unknown>> => ({})
);
vi.mock("@/app/(app)/mail/actions", () => ({
    saveRuleAction: (...args: unknown[]) => saveRuleAction(...args),
    setRuleEnabledAction: (...args: unknown[]) => setRuleEnabledAction(...args),
    deleteRuleAction: (...args: unknown[]) => deleteRuleAction(...args),
    reorderRulesAction: (...args: unknown[]) => reorderRulesAction(...args),
    duplicateRuleAction: async () => ({}),
    runRuleOverInboxAction: async () => ({})
}));

const { RulesView } = await import("@/app/(app)/mail/settings/rules/rules-view");

const ACCOUNT = {
    id: "acc-1",
    address: "me@example.com",
    displayName: "",
    label: "",
    color: null,
    service: "custom",
    serviceName: "Custom",
    auth: "password"
};

/** The filter from the report, as an older Polaris saved it. */
const GITHUB: MailRuleView = {
    id: "r1",
    name: "Auto delete GitHub Failed PRs email notifications",
    enabled: true,
    definition: core.mailFilterFromLegacy({
        match: "all",
        conditions: [{ field: "subject", operator: "contains", value: "PR run failed:" }],
        actions: [{ kind: "trash" }],
        stop: false
    }),
    position: 0,
    matchCount: 4,
    lastRunAt: null
};

const SECOND: MailRuleView = {
    ...GITHUB,
    id: "r2",
    name: "Second fixture filter",
    position: 1,
    matchCount: 0
};

/** A filter that forwards instead of trashing, for the verified-address checks. */
const FORWARDER: MailRuleView = {
    ...GITHUB,
    id: "r3",
    name: "Forward invoices",
    definition: core.mailFilterFromLegacy({
        match: "all",
        conditions: [{ field: "subject", operator: "contains", value: "invoice" }],
        actions: [{ kind: "forward", to: "team@example.com" }],
        stop: false
    }),
    position: 0,
    matchCount: 0
};

function draw(rules: MailRuleView[] = [GITHUB], forwardTargets: string[] = []) {
    render(
        <MessagesWrapper>
            <RulesView
                accounts={[ACCOUNT] as never}
                folders={[]}
                labels={[]}
                rules={{ "acc-1": rules }}
                forwardTargets={forwardTargets}
            />
        </MessagesWrapper>
    );
}

/** The same screen, with a note stack mounted, for the toast a run over the
 *  inbox raises. */
function drawWithToast(rules: MailRuleView[] = [GITHUB], forwardTargets: string[] = []) {
    render(
        <ToastProvider>
            <RulesView
                accounts={[ACCOUNT] as never}
                folders={[]}
                labels={[]}
                rules={{ "acc-1": rules }}
                forwardTargets={forwardTargets}
            />
        </ToastProvider>,
        { wrapper: MessagesWrapper }
    );
}

const wait = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 0)));

beforeEach(() => {
    for (const mock of [saveRuleAction, setRuleEnabledAction, deleteRuleAction, reorderRulesAction])
        mock.mockClear();
});
afterEach(cleanup);

describe("an existing filter", () => {
    it("reads back as a sentence in the list", () => {
        draw();
        expect(
            screen.getByText('If the subject contains "PR run failed:", put it in the trash.')
        ).toBeTruthy();
    });

    it("opens in the editor and saves in place with a second condition", async () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: GITHUB.name }));
        const value = screen.getByRole("textbox", { name: "What to look for" }) as HTMLInputElement;
        expect(value.value).toBe("PR run failed:");
        // Untouched, there is nothing to save.
        expect(
            screen.getByRole("button", { name: "Save the filter" }).getAttribute("aria-disabled")
        ).toBe("true");

        fireEvent.change(value, { target: { value: "Run failed:" } });
        // A second condition in the same group: the sender as well.
        fireEvent.pointerDown(screen.getByRole("button", { name: "Add to this group" }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Sender" }));
        const values = screen.getAllByRole("textbox", { name: "What to look for" });
        expect(values).toHaveLength(2);
        fireEvent.change(values[1]!, { target: { value: "notifications@github.example" } });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save the filter" }));
        });
        expect(saveRuleAction).toHaveBeenCalledTimes(1);
        const [accountId, ruleId, draft] = saveRuleAction.mock.calls[0]! as [
            string,
            string,
            { definition: core.MailFilterDefinition }
        ];
        expect([accountId, ruleId]).toEqual(["acc-1", "r1"]);
        const group = draft.definition.conditions.groups[0]!;
        expect(group.match).toBe("all");
        expect(group.items.map((item) => [item.kind, item.operator, item.value])).toEqual([
            ["subject", "contains", "Run failed:"],
            ["from", "contains", "notifications@github.example"]
        ]);
        // Back on the list at once, with the change already in it.
        expect(
            screen.getByText(
                'If the subject contains "Run failed:" and the sender contains "notifications@github.example", put it in the trash.'
            )
        ).toBeTruthy();
    });

    it("runs over the mail already in the inbox when asked, with nothing else changed", async () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: GITHUB.name }));
        fireEvent.click(
            screen.getByRole("switch", { name: "Also run it over the mail already here" })
        );
        expect(
            screen.getByRole("button", { name: "Save the filter" }).getAttribute("aria-disabled")
        ).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save the filter" }));
        });
        expect(saveRuleAction).toHaveBeenCalledWith(
            "acc-1",
            "r1",
            expect.objectContaining({ applyToExisting: true, definition: GITHUB.definition })
        );
    });

    it("comes back to the editor, as it was typed, when the server refuses the save", async () => {
        saveRuleAction.mockResolvedValueOnce({
            error: "Forward only to an address you have verified on your account."
        });
        draw();
        fireEvent.click(screen.getByRole("button", { name: GITHUB.name }));
        fireEvent.change(screen.getByRole("textbox", { name: "What to look for" }), {
            target: { value: "Run failed:" }
        });
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save the filter" }));
        });
        await wait();
        expect(screen.getByRole("alert").textContent).toContain(
            "Forward only to an address you have verified"
        );
        expect(
            (screen.getByRole("textbox", { name: "What to look for" }) as HTMLInputElement).value
        ).toBe("Run failed:");
        // And the list behind it is what the server holds.
        fireEvent.click(screen.getByRole("button", { name: "All filters" }));
        expect(
            screen.getByText('If the subject contains "PR run failed:", put it in the trash.')
        ).toBeTruthy();
    });

    it("says what is unfinished only once Save is pressed", async () => {
        draw();
        fireEvent.click(screen.getByRole("button", { name: GITHUB.name }));
        fireEvent.change(screen.getByRole("textbox", { name: "What to look for" }), {
            target: { value: "" }
        });
        expect(screen.queryByText("Say what to look for")).toBeNull();
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save the filter" }));
        });
        expect(screen.getByText("Say what to look for")).toBeTruthy();
        expect(saveRuleAction).not.toHaveBeenCalled();
    });

    it("refuses a pattern that could run away as it is typed", () => {
        draw([
            {
                ...GITHUB,
                definition: core.mailFilterFromLegacy({
                    match: "all",
                    conditions: [{ field: "subject", operator: "matches", value: "^PR" }],
                    actions: [{ kind: "trash" }],
                    stop: false
                })
            }
        ]);
        fireEvent.click(screen.getByRole("button", { name: GITHUB.name }));
        fireEvent.change(screen.getByRole("textbox", { name: "What to look for" }), {
            target: { value: "(a+)+$" }
        });
        expect(
            screen.getByText("That pattern could take too long to check. Make it simpler")
        ).toBeTruthy();
    });
});

describe("a filter that forwards", () => {
    it("warns in the list when its address is not a verified one, with a way to fix it", () => {
        draw([FORWARDER], []);
        expect(
            screen.getByText(
                "Not forwarding: team@example.com is not a verified address on your account."
            )
        ).toBeTruthy();
        expect(screen.getByRole("link", { name: "Manage your addresses" })).toBeTruthy();
    });

    it("says nothing once that address is verified", () => {
        draw([FORWARDER], ["team@example.com"]);
        expect(screen.queryByText(/is not a verified address/)).toBeNull();
    });

    it("says mail already here is not forwarded when run over the inbox", async () => {
        drawWithToast([FORWARDER], ["team@example.com"]);
        fireEvent.pointerDown(screen.getByRole("button", { name: `More for ${FORWARDER.name}` }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Run over the inbox now" }));
        expect(
            await screen.findByText(
                `Running ${FORWARDER.name} over the inbox. Mail already here is not forwarded.`
            )
        ).toBeTruthy();
    });
});

describe("the list", () => {
    it("switches a filter off at once, and back on when the server refuses", async () => {
        setRuleEnabledAction.mockResolvedValueOnce({ error: "That rule is not on this mailbox." });
        draw();
        const toggle = screen.getByRole("switch", { name: `${GITHUB.name} on or off` });
        await act(async () => {
            fireEvent.click(toggle);
        });
        expect(setRuleEnabledAction).toHaveBeenCalledWith("acc-1", "r1", false);
        await wait();
        expect(
            screen
                .getByRole("switch", { name: `${GITHUB.name} on or off` })
                .getAttribute("aria-checked")
        ).toBe("true");
    });

    it("moves a filter down and sends the new order", async () => {
        draw([GITHUB, SECOND]);
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: `Move ${GITHUB.name} down` }));
        });
        expect(reorderRulesAction).toHaveBeenCalledWith("acc-1", ["r2", "r1"]);
        const names = screen
            .getAllByRole("listitem")
            .map((item) => within(item).getAllByRole("button")[0]!.textContent);
        expect(names).toEqual([SECOND.name, GITHUB.name]);
    });

    it("asks before deleting, in Polaris' own dialog, then takes the filter off the list", async () => {
        draw([GITHUB, SECOND]);
        fireEvent.pointerDown(screen.getByRole("button", { name: `More for ${GITHUB.name}` }), {
            button: 0,
            ctrlKey: false
        });
        fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText(`Delete ${GITHUB.name}?`)).toBeTruthy();
        expect(deleteRuleAction).not.toHaveBeenCalled();
        await act(async () => {
            fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
        });
        await wait();
        expect(deleteRuleAction).toHaveBeenCalledWith("acc-1", "r1");
        expect(screen.queryByRole("button", { name: GITHUB.name })).toBeNull();
        expect(screen.getByRole("button", { name: SECOND.name })).toBeTruthy();
    });
});
