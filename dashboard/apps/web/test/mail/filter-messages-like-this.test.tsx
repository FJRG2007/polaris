// @vitest-environment jsdom

/**
 * "Filter messages like this", from an open message to a saved filter.
 *
 * The reading pane's menu leads to the filters screen with the filter already
 * written from the message: its sender, and a subject of the same shape. The
 * form shows what that shape is before it is saved, takes more than one
 * condition, and saves exactly what it shows.
 */

import { MessagesWrapper } from "../setup/i18n";
import { filterLikeHref } from "@/app/(app)/mail/thread-view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

let query = new URLSearchParams();
vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
    useSearchParams: () => query
}));
vi.mock("@/lib/session", () => ({}));
vi.mock("@/lib/auth", () => ({}));
const saveRuleAction = vi.fn(async (..._args: unknown[]) => ({ id: "r1" }));
vi.mock("@/app/(app)/mail/actions", () => ({
    saveRuleAction: (...args: unknown[]) => saveRuleAction(...args),
    deleteRuleAction: async () => ({})
}));

const { RulesView } = await import("@/app/(app)/mail/settings/rules/rules-view");

const ACCOUNT = {
    id: "acc-2",
    address: "me@example.com",
    displayName: "",
    label: "",
    color: null,
    service: "custom",
    serviceName: "Custom",
    auth: "password",
    connectionId: null,
    username: "",
    imapHost: "",
    imapPort: 993
};

function screenFor(params: URLSearchParams) {
    query = params;
    render(
        <MessagesWrapper>
            <RulesView
                accounts={[{ ...ACCOUNT, id: "acc-1", address: "other@example.com" }, ACCOUNT] as never}
                folders={[]}
                labels={[]}
                rules={{ "acc-1": [], "acc-2": [] }}
            />
        </MessagesWrapper>
    );
}

const SUBJECT = "[acme/api] Run failed: CI - main (3f2a9c1)";

beforeEach(() => saveRuleAction.mockClear());
afterEach(cleanup);

describe("filter messages like this", () => {
    it("is a link to the filters screen carrying the mailbox, the sender and the subject", () => {
        const href = filterLikeHref("acc-2", "notifications@github.example", SUBJECT);
        const url = new URL(href, "https://polaris.example");
        expect(url.pathname).toBe("/mail/settings/rules");
        expect(url.searchParams.get("account")).toBe("acc-2");
        expect(url.searchParams.get("from")).toBe("notifications@github.example");
        expect(url.searchParams.get("similar")).toBe(SUBJECT);
    });

    it("opens the form on that mailbox, written from the message, and shows the shape", () => {
        screenFor(
            new URLSearchParams({ account: "acc-2", from: "notifications@github.example", similar: SUBJECT })
        );
        expect(screen.getByText("Filters on me@example.com")).toBeTruthy();
        const values = screen.getAllByRole("textbox", { name: "What to look for" }) as HTMLInputElement[];
        expect(values.map((one) => one.value)).toEqual(["notifications@github.example", SUBJECT]);
        expect(screen.getByText(/Matches subjects shaped like: \[\*\] run failed: ci - main \(\*\)/)).toBeTruthy();
    });

    it("saves both conditions, all of which have to hold", async () => {
        screenFor(new URLSearchParams({ account: "acc-2", from: "notifications@github.example", similar: SUBJECT }));
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Save the filter" }));
        });
        expect(saveRuleAction).toHaveBeenCalledWith(
            "acc-2",
            null,
            expect.objectContaining({
                match: "all",
                conditions: [
                    { field: "from", operator: "is", value: "notifications@github.example" },
                    { field: "subject", operator: "similar", value: SUBJECT }
                ],
                actions: [{ kind: "archive" }]
            })
        );
    });

    it("will not save a similar-subject condition that would match nothing, and says why", () => {
        screenFor(new URLSearchParams({ account: "acc-2", similar: "#42" }));
        expect(screen.getByText(/would match nothing/)).toBeTruthy();
        expect((screen.getByRole("button", { name: "Save the filter" }) as HTMLButtonElement).disabled).toBe(true);
    });

    it("opens on a plain screen when nothing asked for a filter", () => {
        screenFor(new URLSearchParams());
        expect(screen.queryByRole("button", { name: "Save the filter" })).toBeNull();
    });
});
