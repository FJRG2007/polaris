// @vitest-environment jsdom

/**
 * The search panel's address fields offer the same contacts the composer does.
 *
 * They were plain inputs, so searching for mail from somebody meant remembering
 * how their address was spelled while the composer, one click away, already
 * knew. Both now read `contact-suggestions`: one lookup, debounced, with stale
 * answers dropped, drawn in a portal so the panel never clips it.
 */

import { MessagesWrapper } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
let query = "";
vi.mock("next/navigation", () => ({
    useRouter: () => ({ replace }),
    usePathname: () => "/mail",
    useSearchParams: () => new URLSearchParams(query)
}));
vi.mock("@/app/(app)/mail/mail-shell", () => ({ useMail: () => ({ shelf: "personal" }) }));
const suggestContactsAction = vi.fn();
vi.mock("@/app/(app)/mail/actions", () => ({
    suggestContactsAction: (...args: unknown[]) => suggestContactsAction(...args)
}));

import { MailSearch } from "@/app/(app)/mail/mail-search";
import { placeUnder } from "@/app/(app)/mail/contact-suggestions";

beforeEach(() => {
    query = "";
    suggestContactsAction.mockImplementation(async (needle: string) => ({
        suggestions: [
            { address: "ana@example.test", name: "Ana Example" },
            { address: "andres@example.test", name: "" }
        ].filter((one) => one.address.startsWith(needle) || one.name.toLowerCase().startsWith(needle))
    }));
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

async function openPanel() {
    const user = userEvent.setup();
    render(<MailSearch />, { wrapper: MessagesWrapper });
    await user.click(screen.getByRole("button", { name: "Search options" }));
    return user;
}

describe("the search panel's address fields", () => {
    it("offer contacts under From, drawn outside the panel, and fill the field from one", async () => {
        const user = await openPanel();
        const from = screen.getByRole("combobox", { name: "From" });
        await user.type(from, "an");

        const list = await screen.findByRole("listbox");
        // In a portal on the page body, so the panel's own box cannot clip it.
        expect(list.parentElement).toBe(document.body);
        expect(suggestContactsAction).toHaveBeenCalledWith("an", "personal");

        await user.keyboard("{ArrowDown}{Enter}");
        expect((from as HTMLInputElement).value).toBe("andres@example.test");
        await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    });

    it("choosing with the pointer keeps the panel open", async () => {
        const user = await openPanel();
        await user.type(screen.getByRole("combobox", { name: "To" }), "ana");
        await user.click(await screen.findByText("Ana Example"));
        expect((screen.getByRole("combobox", { name: "To" }) as HTMLInputElement).value).toBe(
            "ana@example.test"
        );
    });

    it("asks once typing settles, not on every letter", async () => {
        const user = await openPanel();
        await user.type(screen.getByRole("combobox", { name: "Cc" }), "andres");
        await screen.findByRole("listbox");
        expect(suggestContactsAction).toHaveBeenCalledTimes(1);
        expect(suggestContactsAction).toHaveBeenCalledWith("andres", "personal");
    });

    it("drops an answer that arrives after the next letter", async () => {
        let release: (value: unknown) => void = () => undefined;
        suggestContactsAction.mockImplementationOnce(
            () => new Promise((resolve) => (release = resolve))
        );
        const user = await openPanel();
        const from = screen.getByRole("combobox", { name: "From" });
        await user.type(from, "an");
        await waitFor(() => expect(suggestContactsAction).toHaveBeenCalledTimes(1));
        await user.type(from, "dres");
        await screen.findByText("andres@example.test");
        // The first, slower answer lands last and must not replace the list.
        release({ suggestions: [{ address: "stale@example.test", name: "" }] });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByText("stale@example.test")).toBeNull();
    });
});

describe("where the list is drawn", () => {
    const viewport = { width: 1000, height: 800 };

    it("hangs under the field when there is room", () => {
        const place = placeUnder({ top: 100, bottom: 130, left: 50, width: 300 }, viewport);
        expect(place.top).toBe(134);
        expect(place.bottom).toBeUndefined();
    });

    it("opens upwards at the foot of the window", () => {
        const place = placeUnder({ top: 700, bottom: 730, left: 50, width: 300 }, viewport);
        expect(place.top).toBeUndefined();
        expect(place.bottom).toBe(104);
    });

    it("never hangs off the right edge", () => {
        const place = placeUnder({ top: 100, bottom: 130, left: 900, width: 300 }, viewport);
        expect(place.left + place.width).toBeLessThanOrEqual(viewport.width);
    });
});
