// @vitest-environment jsdom

/**
 * A card added to the Overview shows what it watches without a reload.
 *
 * The cards are read from the stored layout, so reading the moment a new card
 * is drawn - before its save is in - came back without it, and the card stayed
 * empty until the page was reloaded. They are read once the save is stored.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppWidgetKind } from "@/lib/overview/app-widgets";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const save = vi.hoisted(() => ({ resolve: null as null | ((answer: { error?: string }) => void) }));
const appWidgets = vi.hoisted(() => vi.fn());

vi.mock("@/app/(app)/home/app-widget-actions", () => ({
    actOnAppWidgetAction: vi.fn(),
    appWidgetTargetsAction: vi.fn(async () => ({ targets: [] })),
    saveAppWidgetsAction: vi.fn(
        () => new Promise<{ error?: string }>((resolve) => (save.resolve = resolve))
    )
}));
vi.mock("@/app/(app)/home/home-polls", () => ({ appWidgets }));

import {
    AppWidgetGridItems,
    useAppWidgets,
    type AppWidgetsState
} from "@/app/(app)/home/app-widgets";

afterEach(cleanup);

const KIND: AppWidgetKind = {
    app: "places",
    kind: "controls",
    label: "Quick controls",
    hint: "",
    defaultSize: "md"
};

function Harness({ onState }: { onState: (state: AppWidgetsState) => void }) {
    const state = useAppWidgets([]);
    onState(state);
    return <AppWidgetGridItems state={state} kinds={[KIND]} />;
}

describe("adding a card to the Overview", () => {
    it("reads it once its save is stored, and draws what came back", async () => {
        let held: AppWidgetsState | null = null;
        // The server answers for the cards it has stored.
        appWidgets.mockImplementation(async () => ({
            cards: Object.fromEntries(
                held!.stored.map((card) => [
                    card.id,
                    {
                        ok: true,
                        view: {
                            items: [
                                { id: "ac", title: "Living room AC", readings: [], controls: [] }
                            ]
                        }
                    }
                ])
            )
        }));
        render(
            <MessagesWrapper>
                <Harness onState={(state) => (held = state)} />
            </MessagesWrapper>
        );

        act(() => held!.add(KIND, ["ac"]));
        // Drawn at once, but not read while the server does not have it yet.
        expect(appWidgets).not.toHaveBeenCalled();

        await act(async () => save.resolve!({}));
        await waitFor(() => expect(appWidgets).toHaveBeenCalledTimes(1));
        expect(await screen.findByText("Living room AC")).toBeTruthy();
    });
});
