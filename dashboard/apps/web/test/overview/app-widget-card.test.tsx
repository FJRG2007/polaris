// @vitest-environment jsdom

/**
 * An app's card, as the Overview draws it.
 *
 * The app answers with data - rows, readings, controls - and the dashboard
 * draws it: a switch for an on and an off, a stepper for a setting, and the
 * reason a control cannot be used where the control is. A press is drawn at once
 * (`withPressed`) and put back if the app refuses.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppWidgetReadout } from "@/lib/overview/app-widgets";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppWidgetBody, withPressed } from "@/app/(app)/home/app-widget-card";

afterEach(cleanup);

const READOUT: AppWidgetReadout = {
    ok: true,
    view: {
        items: [
            {
                id: "ac",
                title: "Living room AC",
                subtitle: "Living room",
                state: "On",
                tone: "ok",
                readings: [{ label: "Room", value: "26.5°C" }],
                controls: [
                    { kind: "toggle", id: "power", label: "Power", on: true, disabled: null },
                    {
                        kind: "number",
                        id: "target",
                        label: "Set to",
                        value: 23,
                        min: 16,
                        max: 30,
                        step: 0.5,
                        unit: "°C",
                        disabled: null
                    }
                ]
            },
            {
                id: "lamp",
                title: "Desk lamp",
                readings: [],
                controls: [
                    { kind: "toggle", id: "power", label: "Power", on: false, disabled: "Offline" }
                ]
            }
        ]
    }
};

function card(readout: AppWidgetReadout | undefined, onAct = vi.fn()) {
    render(
        <MessagesWrapper>
            <AppWidgetBody readout={readout} busy={new Set()} onAct={onAct} onConfigure={vi.fn()} />
        </MessagesWrapper>
    );
    return onAct;
}

describe("an app's card", () => {
    it("draws each row with its readings and state", () => {
        card(READOUT);
        expect(screen.getByText("Living room AC")).toBeTruthy();
        expect(screen.getByText("26.5°C")).toBeTruthy();
        expect(screen.getByText("On")).toBeTruthy();
    });

    it("turns a switch and steps a setting by the app's own step", () => {
        const onAct = card(READOUT);
        fireEvent.click(screen.getByRole("switch", { name: "Power - Living room AC" }));
        expect(onAct).toHaveBeenLastCalledWith({ item: "ac", control: "power", value: false });
        fireEvent.click(screen.getByRole("button", { name: "Raise Set to on Living room AC" }));
        expect(onAct).toHaveBeenLastCalledWith({ item: "ac", control: "target", value: 23.5 });
        fireEvent.click(screen.getByRole("button", { name: "Lower Set to on Living room AC" }));
        expect(onAct).toHaveBeenLastCalledWith({ item: "ac", control: "target", value: 22.5 });
    });

    it("does not offer a control the app says cannot be used, and says why", () => {
        card(READOUT);
        const lamp = screen.getByRole("switch", { name: "Power - Desk lamp" }) as HTMLButtonElement;
        expect(lamp.disabled).toBe(true);
        expect(screen.getByText("Offline")).toBeTruthy();
    });

    it("draws the press before the app answers", () => {
        const pressed = withPressed(READOUT, { item: "ac", control: "target", value: 21 });
        expect(pressed.ok && pressed.view.items[0]?.controls[1]).toMatchObject({ value: 21 });
        expect(pressed.ok && pressed.view.items[1]).toEqual(READOUT.ok && READOUT.view.items[1]);
    });

    it("says when its app is gone, when it could not be read, and while it is on its way", () => {
        card({ ok: false, reason: "gone" });
        expect(screen.getByText(/not available right now/)).toBeTruthy();
        cleanup();
        card({ ok: false, reason: "failed" });
        expect(screen.getByText(/could not be read/)).toBeTruthy();
        cleanup();
        card(undefined);
        expect(document.querySelector("[aria-busy='true']")).not.toBeNull();
    });
});
