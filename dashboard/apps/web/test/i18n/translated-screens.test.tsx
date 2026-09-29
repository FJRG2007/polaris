// @vitest-environment jsdom

/**
 * The screens migrated so far, drawn in both languages.
 *
 * English is asserted against the words these screens always used, which is the
 * promise to everybody reading in English: nothing moved. Spanish is asserted on
 * the parts that are easy to get wrong without noticing - the rail's headings,
 * a sentence with a value in the middle, the day names a week preview is built
 * from.
 *
 * The language picker is exercised through a stand-in for the design system's
 * dropdown (a native one, which jsdom can operate): what is under test is the
 * card's own behaviour - it moves at once, and moves back with the reason when
 * the save is refused.
 */

import type { ReactNode } from "react";
import { withMessages } from "../setup/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveDisplayPreferences } from "@polaris/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
    usePathname: () => "/account/sessions",
    useRouter: () => ({ push: () => undefined, refresh: () => undefined })
}));
vi.mock("@/lib/auth-client", () => ({ signOut: async () => undefined }));
vi.mock("@/components/presence-store", () => ({ usePresenceRefresh: () => () => undefined, usePresence: () => null }));
vi.mock("@/app/(app)/account/sessions/actions", () => ({ noteSignOutAction: async () => undefined }));
vi.mock("@/app/(app)/account/preferences/actions", () => ({
    presenceNowAction: async () => ({}),
    setPresenceAction: async () => ({}),
    setStatusAction: async () => ({})
}));
vi.mock("@polaris/ui", async (original) => ({
    ...(await original<typeof import("@polaris/ui")>()),
    // A native dropdown in place of the design system's, so the test can pick
    // from it. Only the language card is operated through it.
    Select: ({
        value,
        onValueChange,
        options,
        disabled,
        "aria-label": label
    }: {
        value: string;
        onValueChange: (value: string) => void;
        options: { value: string; label: ReactNode }[];
        disabled?: boolean;
        "aria-label"?: string;
    }) => (
        <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)}>
            {options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    )
}));

const { AppSidebar } = await import("@/components/app-sidebar");
const { DisplayPreferencesForm } = await import("@/components/display-preferences-form");
const { LanguageCard } = await import("@/app/(app)/account/preferences/language-card");

afterEach(() => cleanup());

function form(locale: "en-US" | "es-ES") {
    return renderToStaticMarkup(
        withMessages(
            <DisplayPreferencesForm
                initial={{ weekStart: "mon" }}
                fallback={resolveDisplayPreferences({ weekStart: "sun" }, undefined, locale)}
                allowInherit
                save={async () => ({})}
            />,
            locale
        )
    );
}

describe("the rail", () => {
    it("reads exactly as it always did in English", () => {
        const markup = renderToStaticMarkup(withMessages(<AppSidebar />));
        expect(markup).toContain("My account</p>");
        expect(markup).toContain("Security</p>");
        expect(markup).toContain(">Sessions<");
        expect(markup).toContain(">Password &amp; 2FA<");
    });

    it("reads in Spanish for a Spanish reader", () => {
        const markup = renderToStaticMarkup(withMessages(<AppSidebar />, "es-ES"));
        expect(markup).toContain("Mi cuenta</p>");
        expect(markup).toContain("Seguridad</p>");
        expect(markup).toContain(">Sesiones<");
        expect(markup).not.toContain(">Sessions<");
    });
});

describe("the preferences form", () => {
    it("says what the default resolves to, in the reader's words", () => {
        expect(form("en-US")).toContain("Platform default (Sunday)");
        expect(form("es-ES")).toContain("Predeterminado de la plataforma (Domingo)");
    });

    it("builds the week preview from the language's own day names", () => {
        expect(form("en-US")).toContain("Mon to Sun");
        expect(form("es-ES")).toContain("De lun a dom");
    });

    it("offers no language field of its own - the language has its own card", () => {
        expect(form("en-US")).not.toContain("English is the only language");
    });
});

describe("the account menu", () => {
    it("names its entries in the reader's language", async () => {
        const { AccountMenu } = await import("@/components/account-menu");
        render(
            withMessages(
                <AccountMenu
                    id="ada"
                    name="Ada"
                    email="ada@example.com"
                    presence="auto"
                    presenceUntil={null}
                    presenceScheduled={false}
                    presenceNextChange={null}
                    status=""
                    statusUntil={null}
                />,
                "es-ES"
            )
        );
        const trigger = screen.getByRole("button", { name: "Tu cuenta" });
        fireEvent.contextMenu(trigger);
        expect(await screen.findByText("Cerrar sesión")).toBeDefined();
        expect(screen.getByText("Mi cuenta")).toBeDefined();
        expect(screen.getByText("En línea")).toBeDefined();
    });
});

describe("the language card", () => {
    it("moves at once, and back with the reason when the save is refused", async () => {
        let refuse: (answer: { error?: string }) => void = () => undefined;
        const save = vi.fn(() => new Promise<{ error?: string }>((resolve) => (refuse = resolve)));
        render(withMessages(<LanguageCard current="en-US" save={save} />));

        const picker = screen.getByRole("combobox", { name: "Language" }) as HTMLSelectElement;
        fireEvent.change(picker, { target: { value: "es-ES" } });
        expect(save).toHaveBeenCalledWith("es-ES");
        expect(picker.value).toBe("es-ES");

        refuse({ error: "That language is not available." });
        await waitFor(() => expect(picker.value).toBe("en-US"));
        expect(screen.getByText("That language is not available.")).toBeDefined();
    });

    it("sends nothing when the language picked is the one in use", () => {
        const save = vi.fn(async () => ({}));
        render(withMessages(<LanguageCard current="es-ES" save={save} />, "es-ES"));
        fireEvent.change(screen.getByRole("combobox", { name: "Idioma" }), { target: { value: "es-ES" } });
        expect(save).not.toHaveBeenCalled();
    });

    it("lists every language in itself", () => {
        render(withMessages(<LanguageCard current="en-US" save={async () => ({})} />));
        expect(screen.getByRole("option", { name: "Español (España)" })).toBeDefined();
        expect(screen.getByRole("option", { name: "English (US)" })).toBeDefined();
    });
});
