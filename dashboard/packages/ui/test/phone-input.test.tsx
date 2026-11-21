// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PhoneInput, phoneCountryOptions } from "../src/components/phone-input";

afterEach(cleanup);

// Fixture numbers only (a placeholder in Spain's 600 mobile range).
function Harness({ start = "", onValue }: { start?: string; onValue?: (value: string) => void }) {
    const [value, setValue] = useState(start);
    return (
        <PhoneInput
            value={value}
            defaultCountry="ES"
            showError
            onChange={(next) => {
                setValue(next);
                onValue?.(next);
            }}
        />
    );
}

describe("PhoneInput", () => {
    it("groups a typed national number and reports it in E.164", () => {
        const seen: string[] = [];
        render(<Harness onValue={(value) => seen.push(value)} />);
        const field = screen.getByRole("textbox") as HTMLInputElement;
        fireEvent.change(field, { target: { value: "600111222" } });
        expect(field.value).toBe("600 11 12 22");
        expect(seen.at(-1)).toBe("+34600111222");
    });

    it("shows a stored number split into its country and national part", () => {
        render(<Harness start="+34600111222" />);
        expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("600 11 12 22");
        expect(document.querySelector("[data-flag='es']")).not.toBeNull();
    });

    it("moves to the country of a pasted international number", () => {
        const seen: string[] = [];
        render(<Harness onValue={(value) => seen.push(value)} />);
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "+1 201 555 0123" } });
        expect(seen.at(-1)).toBe("+12015550123");
        expect(document.querySelector("[data-flag='us']")).not.toBeNull();
    });

    it("says when a number cannot exist, and clears to an empty value", () => {
        const seen: string[] = [];
        render(<Harness onValue={(value) => seen.push(value)} />);
        const field = screen.getByRole("textbox");
        fireEvent.change(field, { target: { value: "6001" } });
        expect(field.getAttribute("aria-invalid")).toBe("true");
        fireEvent.change(field, { target: { value: "" } });
        expect(seen.at(-1)).toBe("");
        expect(field.getAttribute("aria-invalid")).toBeNull();
    });
});

describe("phoneCountryOptions", () => {
    it("finds a country by its name, its English name and its calling code", () => {
        const spain = phoneCountryOptions("es-ES").find((option) => option.value === "ES")!;
        expect(spain.label).toBe("España");
        expect(spain.hint).toBe("+34");
        expect(spain.keywords).toContain("Spain");
        expect(spain.keywords).toContain("+34");
        const peru = phoneCountryOptions("es-ES").find((option) => option.value === "PE")!;
        expect(peru.keywords).toContain("Peru");
    });
});
