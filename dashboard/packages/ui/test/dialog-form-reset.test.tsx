// @vitest-environment jsdom

/**
 * A form in a dialog starts from scratch every time it opens (BUG-0078).
 *
 * Two halves: the dialog's content is unmounted while it is closed, so state
 * kept inside it never survives a close; and `useResetOnOpen` resets the state
 * a component keeps beside the `Dialog` root, which stays mounted.
 */

import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "../src/components/dialog";
import { DIALOG_WIPE_MS, useResetOnOpen } from "../src/lib/use-reset-on-open";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function Body() {
    const [value, setValue] = useState("");
    return <input aria-label="Inner" value={value} onChange={(event) => setValue(event.target.value)} />;
}

function Shell({ open }: { open: boolean }) {
    return (
        <Dialog open={open}>
            <DialogContent aria-describedby={undefined}>
                <DialogTitle>Title</DialogTitle>
                <Body />
            </DialogContent>
        </Dialog>
    );
}

/** An add-or-edit dialog whose fields live beside the Dialog root. */
function Owned({ open, record }: { open: boolean; record?: { name: string } }) {
    const [name, setName] = useState(record?.name ?? "");
    useResetOnOpen(open, () => setName(record?.name ?? ""));
    return (
        <>
            <output aria-label="Held">{name}</output>
            <Dialog open={open}>
                <DialogContent aria-describedby={undefined}>
                    <DialogTitle>Title</DialogTitle>
                    <input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} />
                </DialogContent>
            </Dialog>
        </>
    );
}

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

describe("DialogContent", () => {
    it("unmounts what it holds while closed, so its own state starts again", () => {
        const view = render(<Shell open />);
        fireEvent.change(field("Inner"), { target: { value: "typed" } });
        view.rerender(<Shell open={false} />);
        expect(screen.queryByLabelText("Inner")).toBeNull();
        view.rerender(<Shell open />);
        expect(field("Inner").value).toBe("");
    });
});

describe("useResetOnOpen", () => {
    it("opens an add form empty after a value was typed and the dialog closed", () => {
        const view = render(<Owned open />);
        fireEvent.change(field("Name"), { target: { value: "+34 600 000 000" } });
        view.rerender(<Owned open={false} />);
        view.rerender(<Owned open />);
        expect(field("Name").value).toBe("");
    });

    it("opens an edit form on the record being edited, not on the last edit", () => {
        const view = render(<Owned open record={{ name: "Alpha" }} />);
        fireEvent.change(field("Name"), { target: { value: "Alpha changed" } });
        view.rerender(<Owned open={false} record={{ name: "Alpha" }} />);
        view.rerender(<Owned open record={{ name: "Beta" }} />);
        expect(field("Name").value).toBe("Beta");
        view.rerender(<Owned open={false} record={{ name: "Beta" }} />);
        view.rerender(<Owned open record={{ name: "Beta" }} />);
        expect(field("Name").value).toBe("Beta");
    });

    it("wipes what was typed from memory once the dialog has been closed a moment", () => {
        vi.useFakeTimers();
        const view = render(<Owned open />);
        fireEvent.change(field("Name"), { target: { value: "secret-code" } });
        view.rerender(<Owned open={false} />);
        expect(screen.getByLabelText("Held").textContent).toBe("secret-code");
        act(() => {
            vi.advanceTimersByTime(DIALOG_WIPE_MS);
        });
        expect(screen.getByLabelText("Held").textContent).toBe("");
    });

    it("keeps the values while the flow stays open, and leaves a first open alone", () => {
        vi.useFakeTimers();
        const view = render(<Owned open record={{ name: "Gamma" }} />);
        fireEvent.change(field("Name"), { target: { value: "Gamma edited" } });
        view.rerender(<Owned open record={{ name: "Gamma" }} />);
        act(() => {
            vi.advanceTimersByTime(DIALOG_WIPE_MS * 3);
        });
        expect(field("Name").value).toBe("Gamma edited");
    });
});
