// @vitest-environment jsdom

/**
 * Where the comma between two recipients is drawn.
 *
 * A chip does not end where it looks like it ends. After the address sits a copy
 * button that is transparent until somebody points at the row - transparent, not
 * absent, so it holds its width the whole time. A comma written after the chip
 * was therefore a comma written after an invisible control: a clear gap between
 * the address and its own punctuation, and a comma that wrapped onto a line of
 * its own when the header ran out of room.
 *
 * That is what this pins: the separator belongs to the chip, and inside it, it
 * comes before the button rather than after it.
 */

import { ToastProvider } from "@polaris/ui";
import { AddressChip } from "@/app/(app)/mail/address-chip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/app/(app)/mail/mail-shell", () => ({
    useMail: () => ({ openComposer: () => undefined })
}));

afterEach(cleanup);

const ENTRY = { name: "Albert Kampde", address: "albert@example.test" };

/** The chip's own element, reached from the one thing in it with a name. */
function chipFor(address: string): { chip: HTMLElement; copy: HTMLElement } {
    const copy = screen.getByRole("button", { name: `Copy ${address}` });
    const chip = copy.parentElement;
    if (!chip) throw new Error("The copy button is not inside anything");
    return { chip, copy };
}

function draw(after?: string): void {
    render(
        <ToastProvider>
            <AddressChip entry={ENTRY} {...(after === undefined ? {} : { after })} />
        </ToastProvider>
    );
}

describe("the comma between two recipients", () => {
    it("is drawn inside the chip", () => {
        draw(",");
        const { chip } = chipFor(ENTRY.address);
        const comma = [...chip.children].find((node) => node.textContent === ",");
        expect(comma).toBeDefined();
    });

    it("comes before the button that holds width while invisible", () => {
        // The defect itself. Both orders draw a comma; only one draws it against
        // the address, and the other leaves the width of a hidden control between
        // the two.
        draw(",");
        const { chip, copy } = chipFor(ENTRY.address);
        const nodes = [...chip.children];
        const commaAt = nodes.findIndex((node) => node.textContent === ",");
        expect(commaAt).toBeGreaterThanOrEqual(0);
        expect(commaAt).toBeLessThan(nodes.indexOf(copy));
    });

    it("is not drawn at all for the last one in a list", () => {
        draw("");
        const { chip } = chipFor(ENTRY.address);
        expect([...chip.children].some((node) => node.textContent === ",")).toBe(false);
    });

    it("is absent where nobody asked for one", () => {
        draw();
        const { chip } = chipFor(ENTRY.address);
        expect(chip.textContent).not.toContain(",");
    });
});
