// @vitest-environment jsdom

/**
 * A service that refused somebody can be marked seen straight from the grid,
 * the same way any other alert is cleared, without opening its setup.
 */

import { withMessages } from "../setup/i18n";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVICE_INTEGRATIONS } from "@/lib/integrations/registry";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { IntegrationCard } from "@/app/(app)/admin/integrations/integrations-view";

const { dismiss, refresh } = vi.hoisted(() => ({
    dismiss: vi.fn(async (_slug: string) => ({})),
    refresh: vi.fn()
}));

vi.mock("@/app/(app)/admin/integrations/actions", () => ({
    dismissConnectionFailureAction: dismiss
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const { IntegrationsView } = await import("@/app/(app)/admin/integrations/integrations-view");

afterEach(() => cleanup());

function card(slug: string, overrides: Partial<IntegrationCard> = {}): IntegrationCard {
    const entry = SERVICE_INTEGRATIONS.find((candidate) => candidate.slug === slug);
    if (!entry) throw new Error(`no catalog entry for ${slug}`);
    return {
        slug: entry.slug,
        name: entry.name,
        category: entry.category,
        summary: entry.summary,
        description: entry.description,
        docsUrl: entry.docsUrl,
        requiresApiKey: entry.requiresApiKey,
        enabled: true,
        hasSecret: true,
        scanDropPoints: true,
        onDetection: "block",
        verifyAccessIp: true,
        deny: [],
        ...overrides
    };
}

describe("marking a refused service seen from the grid", () => {
    it("offers it only on the card that needs attention, and clears it", async () => {
        const [first, second] = SERVICE_INTEGRATIONS;
        if (!first || !second) throw new Error("catalogue too small");
        const failing = card(first.slug, {
            failure: {
                at: "2026-10-15T10:00:00.000Z",
                reason: "invalid_client",
                kind: "refusal"
            }
        });
        render(withMessages(<IntegrationsView cards={[failing, card(second.slug)]} />, "en-US"));

        const buttons = screen.getAllByRole("button", { name: /as seen$/ });
        expect(buttons).toHaveLength(1);
        expect(buttons[0]!.getAttribute("aria-label")).toBe(`Mark ${first.name} as seen`);

        await userEvent.click(buttons[0]!);
        await waitFor(() => expect(refresh).toHaveBeenCalled());
        expect(dismiss).toHaveBeenCalledWith(first.slug);
    });

    it("keeps saying it needs attention once seen, without asking again", () => {
        const [first] = SERVICE_INTEGRATIONS;
        if (!first) throw new Error("catalogue too small");
        const seen = card(first.slug, {
            failure: {
                at: "2026-10-15T10:00:00.000Z",
                reason: "invalid_client",
                kind: "refusal",
                seenAt: "2026-10-15T11:00:00.000Z"
            }
        });
        render(withMessages(<IntegrationsView cards={[seen]} />, "en-US"));

        expect(screen.getByText("Needs attention")).toBeTruthy();
        expect(screen.queryByText("On")).toBeNull();
        expect(screen.queryAllByRole("button", { name: /as seen$/ })).toHaveLength(0);
    });

    it("says on the card when it could not be marked", async () => {
        const [first] = SERVICE_INTEGRATIONS;
        if (!first) throw new Error("catalogue too small");
        dismiss.mockResolvedValueOnce({ error: "That could not be saved" });
        const failing = card(first.slug, {
            failure: { at: "2026-10-15T10:00:00.000Z", reason: "x", kind: "refusal" }
        });
        render(withMessages(<IntegrationsView cards={[failing]} />, "en-US"));

        await userEvent.click(screen.getByRole("button", { name: /as seen$/ }));
        expect((await screen.findByRole("alert")).textContent).toBe("That could not be saved");
    });
});
