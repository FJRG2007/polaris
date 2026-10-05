// @vitest-environment jsdom

/**
 * The exception to the account's network rules, in the dialog that sets where
 * a connection may call from: offered only when the rules restrict something,
 * saved with the address rule, and shown but not changeable by somebody who is
 * not an administrator.
 */

import { MessagesWrapper } from "../../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NO_EXCEPTION } from "@/lib/mcp/oauth/network-exception";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IpRuleDialog } from "@/app/(app)/account/assistants/ip-rule-dialog";

const OPEN = { mode: "none" as const, allow: [], deny: [] };

function draw(props: { restricted: boolean; canExcept: boolean }) {
    const onSave = vi.fn();
    render(
        <MessagesWrapper>
            <IpRuleDialog
                name="ChatGPT"
                current={OPEN}
                approvedIp={null}
                exception={NO_EXCEPTION}
                onCancel={() => undefined}
                onSave={onSave}
                {...props}
            />
        </MessagesWrapper>
    );
    return onSave;
}

afterEach(cleanup);

describe("a connection's exception in the address dialog", () => {
    it("is not offered when the account's rules restrict nothing", () => {
        draw({ restricted: false, canExcept: true });
        expect(screen.queryByText("Also allow from")).toBeNull();
    });

    it("lets an administrator add the United States and saves it with the rule", () => {
        const onSave = draw({ restricted: true, canExcept: true });
        const save = screen.getByRole("button", { name: "Save" });
        expect(save).toHaveProperty("disabled", true);

        const countries = screen
            .getAllByRole("textbox")
            .find((input) =>
                (input as HTMLInputElement).placeholder.toLowerCase().includes("countr")
            ) as HTMLInputElement;
        fireEvent.change(countries, { target: { value: "United States" } });
        fireEvent.mouseDown(screen.getByRole("button", { name: "United States" }));

        expect(save).toHaveProperty("disabled", false);
        fireEvent.click(save);
        expect(onSave).toHaveBeenCalledWith(
            OPEN,
            expect.objectContaining({ allowedCountries: ["US"], presets: [] })
        );
    });

    it("shows somebody who is not an administrator why it cannot be changed", () => {
        draw({ restricted: true, canExcept: false });
        expect(
            screen.getByText(
                "Only an administrator can let a connection past the network rules an administrator set."
            )
        ).toBeTruthy();
        // Disabled by its fieldset, which is how the browser greys out every field
        // inside at once.
        expect(
            screen
                .getByRole("checkbox", { name: /OpenAI's published addresses/ })
                .matches(":disabled")
        ).toBe(true);
    });
});
