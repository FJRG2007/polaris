/**
 * What is still typed in the addresses box when Create is pressed is folded into
 * the chips: split on spaces, commas and semicolons, normalized, and refused
 * whole when any part is not an address.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/ui", () => ({ Button: () => null, Input: () => null }));
vi.mock("@/components/app-url", () => ({ useAppUrl: () => "" }));
vi.mock("@/app/(app)/chat/links", () => ({ copyText: vi.fn() }));
vi.mock("@/components/display-format", () => ({ useDisplayFormat: () => ({}) }));
vi.mock("@/components/i18n/i18n-provider", () => ({ useTranslations: () => (key: string) => key }));

import { withDraft } from "@/app/(app)/chat/meetings/meeting-invitation";

describe("withDraft", () => {
    it("keeps an address with an s in it whole", () => {
        expect(withDraft([], "james@example.com")).toEqual(["james@example.com"]);
    });

    it("splits a draft on spaces, commas and semicolons", () => {
        expect(withDraft(["ada@example.com"], " sam@example.com  ross@example.com,ada@example.com; Tess@Example.com "))
            .toEqual(["ada@example.com", "sam@example.com", "ross@example.com", "tess@example.com"]);
    });

    it("returns the chips unchanged for an empty draft", () => {
        expect(withDraft(["ada@example.com"], "   ")).toEqual(["ada@example.com"]);
    });

    it("refuses a draft with a part that is not an address", () => {
        expect(withDraft([], "sam@example.com nope")).toBeNull();
    });
});
