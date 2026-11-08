// @vitest-environment jsdom

/**
 * What somebody pinned inside an app, under that app's rail: asked of the app,
 * drawn with the names they gave (never translated), and only links that stay
 * inside the dashboard.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesWrapper } from "../setup/i18n";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/crm/companies" }));

const { AppSidebar } = await import("@/components/app-sidebar");
const { readFavoriteItems } = await import("@/components/use-app-favorites");

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
});

describe("an app's favorites in its rail", () => {
    it("lists them under Favorites, named as they were named", async () => {
        const fetched = vi.fn(async () =>
            Response.json({
                favorites: [
                    { id: "f1", label: "People", href: "/crm/people/p1" },
                    { id: "f2", label: "Companies: Hot leads", href: "/crm/companies?view=v1" }
                ]
            })
        );
        vi.stubGlobal("fetch", fetched);
        render(<AppSidebar appIds={["crm"]} installed={["crm"]} />, { wrapper: MessagesWrapper });
        const link = await screen.findByRole("link", { name: "Companies: Hot leads" });
        expect(link.getAttribute("href")).toBe("/crm/companies?view=v1");
        expect(screen.getByText("Favorites")).toBeTruthy();
        // A record somebody called "People" is that record, not the People screen.
        const named = screen.getAllByRole("link", { name: "People" });
        expect(named.some((one) => one.getAttribute("href") === "/crm/people/p1")).toBe(true);
        expect(fetched).toHaveBeenCalledWith("/api/apps/favorites?app=crm", expect.anything());
    });

    it("draws no heading when nothing is pinned", async () => {
        const fetched = vi.fn(async () => Response.json({ favorites: [] }));
        vi.stubGlobal("fetch", fetched);
        render(<AppSidebar appIds={["crm"]} installed={["crm"]} />, { wrapper: MessagesWrapper });
        await waitFor(() => expect(fetched).toHaveBeenCalled());
        expect(screen.queryByText("Favorites")).toBeNull();
    });

    it("keeps only well-formed links inside the dashboard", () => {
        expect(
            readFavoriteItems({
                favorites: [
                    { id: "a", label: "Kept", href: "/crm/people/p1" },
                    { id: "b", label: "Elsewhere", href: "https://example.invalid/" },
                    { id: "c", label: "Protocol-relative", href: "//example.invalid/" },
                    { id: "d", label: 3, href: "/crm" }
                ]
            })
        ).toEqual([{ id: "a", label: "Kept", href: "/crm/people/p1" }]);
        expect(readFavoriteItems(null)).toEqual([]);
    });
});
