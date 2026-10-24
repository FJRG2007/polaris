// @vitest-environment jsdom

/**
 * The canvas's node picker: groups named by where a node comes from, each item
 * with its words, and a preset picked hands back its value.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/app/(app)/automations/actions", () => ({}));

import { MessagesWrapper } from "../setup/i18n";
import { Palette } from "@/app/(app)/automations/[id]/canvas-editor";

afterEach(cleanup);

function open(props: { stepsOnly?: boolean; triggersOnly?: boolean; apps?: string[] } = {}) {
    const onPick = vi.fn();
    render(
        <Palette
            open
            stepsOnly={props.stepsOnly ?? false}
            triggersOnly={props.triggersOnly}
            apps={props.apps ?? []}
            onOpenChange={vi.fn()}
            onPick={onPick}
        />,
        { wrapper: MessagesWrapper }
    );
    return onPick;
}

describe("the node picker", () => {
    it("groups triggers by where they come from", () => {
        open({ apps: ["home"] });
        for (const name of ["Basics", "Polaris", "Automations", "Places", "Logic", "Send"])
            expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    });

    it("finds a Polaris event by its words and hands back the preset", () => {
        const onPick = open();
        fireEvent.change(screen.getByPlaceholderText("Search nodes"), {
            target: { value: "NAS went offline" }
        });
        fireEvent.click(screen.getByText("NAS went offline"));
        expect(onPick).toHaveBeenCalledWith("core.onEvent#nasOffline");
    });

    it("offers no step groups where only a trigger fits", () => {
        open({ triggersOnly: true });
        expect(screen.getAllByText("Basics").length).toBeGreaterThan(0);
        expect(screen.queryByText("Logic")).toBeNull();
    });

    it("offers no trigger groups where only a step fits", () => {
        open({ stepsOnly: true });
        expect(screen.queryByText("Basics")).toBeNull();
        expect(screen.getAllByText("Logic").length).toBeGreaterThan(0);
    });
});
