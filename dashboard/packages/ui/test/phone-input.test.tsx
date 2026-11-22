// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { findPhoneCountries, PhoneInput, phoneCountryOptions, PhoneRegionProvider } from "../src/components/phone-input";

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

describe("PhoneInput's starting country", () => {
    it("starts on the country the server placed the request in", () => {
        render(
            <PhoneRegionProvider country="PT">
                <PhoneInput value="" onChange={() => {}} />
            </PhoneRegionProvider>
        );
        expect(document.querySelector("[data-flag='pt']")).not.toBeNull();
    });

    it("never moves a stored number to the reader's region", () => {
        render(
            <PhoneRegionProvider country="PT">
                <PhoneInput value="+34600111222" onChange={() => {}} />
            </PhoneRegionProvider>
        );
        expect(document.querySelector("[data-flag='es']")).not.toBeNull();
        expect(document.querySelector("[data-flag='pt']")).toBeNull();
    });

    it("keeps a country the screen asked for over the region", () => {
        render(
            <PhoneRegionProvider country="PT">
                <PhoneInput value="" defaultCountry="MX" onChange={() => {}} />
            </PhoneRegionProvider>
        );
        expect(document.querySelector("[data-flag='mx']")).not.toBeNull();
    });
});

describe("findPhoneCountries", () => {
    const options = phoneCountryOptions("en-US");
    const first = (query: string) => findPhoneCountries(options, query)[0]?.value;

    it("puts the country with that calling code first, with or without the plus", () => {
        expect(first("+34")).toBe("ES");
        expect(first("34")).toBe("ES");
        expect(first("+351")).toBe("PT");
    });

    it("puts the main country of a shared calling code ahead of the others", () => {
        expect(first("+1")).toBe("US");
        expect(first("44")).toBe("GB");
        expect(first("+7")).toBe("RU");
    });

    it("puts a country's own code first", () => {
        expect(first("es")).toBe("ES");
        expect(first("PT")).toBe("PT");
    });

    it("finds a country by the start of its name, in the reader's language or English", () => {
        expect(first("spa")).toBe("ES");
        expect(findPhoneCountries(phoneCountryOptions("es-ES"), "spain")[0]?.value).toBe("ES");
        expect(findPhoneCountries(phoneCountryOptions("es-ES"), "peru")[0]?.value).toBe("PE");
    });

    it("leaves the whole list when nothing is typed", () => {
        expect(findPhoneCountries(options, " ")).toHaveLength(options.length);
    });
});
