// @vitest-environment jsdom

/**
 * Inline forms (`polar_form`): only the closed field set is drawn, values are
 * checked against each field's schema, the server rewrites the reply's text
 * from the checked values and refuses a reply to a form it never drew, one
 * already answered, or one whose values fail; the view validates as you type
 * and locks once sent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const { MessagesWrapper } = await import("../setup/i18n");
const forms = await import("@/lib/polar/forms");
const { PolarFormView } = await import("@/components/polar/polar-form");

afterEach(cleanup);

const form = {
    title: "Booking",
    fields: [
        { id: "name", type: "text", label: "Name", required: true },
        { id: "notes", type: "textarea", label: "Notes" },
        { id: "room", type: "choice", label: "Room", options: ["Single", "Double"], required: true },
        { id: "extras", type: "choice", label: "Extras", options: ["Breakfast", "Parking"], multiple: true },
        { id: "stars", type: "rating", label: "Stars", max: 5 },
        { id: "guests", type: "number", label: "Guests", min: 1, max: 4 },
        { id: "day", type: "date", label: "Day", min: "2026-01-01" }
    ]
};

describe("form schema", () => {
    it("takes the closed set and refuses anything else", () => {
        expect(forms.formOf(form)).not.toBeNull();
        expect(forms.formOf({ fields: [{ id: "x", type: "html", label: "X", html: "<script>" }] })).toBeNull();
        expect(forms.formOf({ fields: [{ id: "a", type: "text", label: "A" }, { id: "a", type: "text", label: "B" }] })).toBeNull();
        expect(forms.formOf({ fields: [] })).toBeNull();
        expect(forms.formOf({ fields: [{ id: "d", type: "date", label: "D", min: "2026-02-30" }] })).toBeNull();
    });

    it("checks values field by field, after trimming", () => {
        const parsed = forms.formOf(form)!;
        const ok = forms.checkFormValues(parsed, {
            name: "  Ada  ",
            notes: "   ",
            room: "Double",
            extras: ["Parking"],
            stars: 4,
            guests: 2,
            day: "2026-03-01"
        });
        expect(ok).toEqual({
            ok: true,
            values: { name: "Ada", room: "Double", extras: ["Parking"], stars: 4, guests: 2, day: "2026-03-01" }
        });
        const bad = forms.checkFormValues(parsed, { name: "", room: "Suite", stars: 9, guests: 7, day: "2025-12-31", extra: "x" });
        expect(bad.ok).toBe(false);
        expect(bad.ok ? [] : bad.fields.sort()).toEqual(["", "day", "guests", "name", "room", "stars"].sort());
    });

    it("writes one line per answered field", () => {
        const parsed = forms.formOf(form)!;
        expect(forms.formReplyText(parsed, { name: "Ada", extras: ["Breakfast", "Parking"], stars: 4 })).toBe(
            "Booking\nName: Ada\nExtras: Breakfast, Parking\nStars: 4/5"
        );
    });
});

describe("server check of a reply", () => {
    const drawn = {
        role: "assistant",
        parts: [{ type: `tool-${forms.POLAR_FORM_TOOL}`, toolCallId: "f1", state: "output-available", input: form }]
    };
    const reply = (values: object, callId = "f1") => ({
        role: "user",
        parts: [{ type: "text", text: "anything the client wrote" }],
        metadata: { form: { callId, values } }
    });

    it("rewrites the text from the checked values", () => {
        const out = forms.checkFormReply([drawn, reply({ name: " Ada ", room: "Single" })]);
        expect(out?.at(-1)).toMatchObject({
            parts: [{ type: "text", text: "Booking\nName: Ada\nRoom: Single" }],
            metadata: { form: { callId: "f1", values: { name: "Ada", room: "Single" } } }
        });
    });

    it("refuses invalid values, an unknown form and a second answer", () => {
        expect(forms.checkFormReply([drawn, reply({ name: "Ada" })])).toBeNull();
        expect(forms.checkFormReply([drawn, reply({ name: "Ada", room: "Single" }, "nope")])).toBeNull();
        expect(
            forms.checkFormReply([drawn, reply({ name: "Ada", room: "Single" }), { role: "assistant", parts: [] }, reply({ name: "Bo", room: "Single" })])
        ).toBeNull();
        expect(forms.checkFormReply([drawn, { role: "user", parts: [], metadata: { form: "x" } }])).toBeNull();
    });

    it("leaves any other message alone", () => {
        const plain = { role: "user", parts: [{ type: "text", text: "hi" }] };
        expect(forms.checkFormReply([drawn, plain])).toEqual([drawn, plain]);
    });
});

describe("form view", () => {
    it("checks as you type and sends checked values", () => {
        const onSubmit = vi.fn();
        render(
            <MessagesWrapper>
                <PolarFormView input={form} sent={null} disabled={false} onSubmit={onSubmit} />
            </MessagesWrapper>
        );
        const send = screen.getByRole("button", { name: "Send" });
        expect(send.getAttribute("aria-disabled")).toBe("true");
        fireEvent.click(send);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(screen.getAllByText("Required").length).toBeGreaterThan(0);
        fireEvent.change(screen.getByLabelText(/Name/), { target: { value: "Ada" } });
        fireEvent.click(screen.getByRole("radio", { name: "Double" }));
        fireEvent.click(screen.getByRole("radio", { name: "4 of 5 stars" }));
        fireEvent.change(screen.getByLabelText("Guests"), { target: { value: "9" } });
        expect(screen.getByText("Check this field")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Guests"), { target: { value: "3" } });
        fireEvent.click(screen.getByRole("button", { name: "Send" }));
        expect(onSubmit).toHaveBeenCalledWith({ name: "Ada", room: "Double", stars: 4, guests: 3 });
    });

    it("shows what was sent and takes no more input", () => {
        render(
            <MessagesWrapper>
                <PolarFormView input={form} sent={{ name: "Ada", room: "Single" }} disabled={false} onSubmit={vi.fn()} />
            </MessagesWrapper>
        );
        expect(screen.getByText("Sent")).toBeTruthy();
        expect((screen.getByLabelText(/Name/) as HTMLInputElement).value).toBe("Ada");
        expect((screen.getByLabelText(/Name/) as HTMLInputElement).disabled).toBe(true);
        expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    });

    it("draws nothing for a form outside the set", () => {
        const { container } = render(
            <MessagesWrapper>
                <PolarFormView input={{ fields: [{ type: "script" }] }} sent={null} disabled={false} onSubmit={vi.fn()} />
            </MessagesWrapper>
        );
        expect(container.textContent).toBe("");
    });
});
