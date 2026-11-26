// @vitest-environment jsdom

/**
 * A submenu laid over its menu (a phone) covers the options under its trigger,
 * and Radix only ever opens one on a tap. While it overlaps, a press outside it
 * shuts it, and a tap on its own open trigger shuts it too - the press there is
 * left to the trigger, or the tap's click would open it straight back.
 */

import * as fit from "../src/lib/submenu-fit";
import { useRef, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(cleanup);

function Harness({ overlapping, close }: { overlapping: boolean; close: () => void }) {
    const trigger = useRef<HTMLButtonElement | null>(null);
    const state = {
        trigger,
        offsets: overlapping ? { sideOffset: -100, alignOffset: 32 } : null,
        close
    };
    return (
        <fit.SubmenuFitProvider value={state}>
            <Parts trigger={trigger}>
                <span data-testid="elsewhere">Notifications</span>
            </Parts>
        </fit.SubmenuFitProvider>
    );
}

function Parts({ trigger, children }: { trigger: React.RefObject<HTMLButtonElement | null>; children: ReactNode }) {
    const dismiss = fit.useOverlapDismiss();
    const toggle = fit.useOverlapToggle();
    return (
        <>
            <button ref={trigger} type="button" data-state="open" onClick={toggle}>
                <span data-testid="label">Mute</span>
            </button>
            {children}
            <button type="button" data-testid="outside-on-trigger" onClick={() => dismiss({ target: screen.getByTestId("label") } as unknown as Event)} />
            <button type="button" data-testid="outside-elsewhere" onClick={() => dismiss({ target: screen.getByTestId("elsewhere") } as unknown as Event)} />
        </>
    );
}

describe("an overlapping submenu on touch", () => {
    it("shuts on a press outside it", () => {
        const close = vi.fn();
        render(<Harness overlapping close={close} />);
        fireEvent.click(screen.getByTestId("outside-elsewhere"));
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("leaves a press on its own trigger to the trigger, which shuts it", () => {
        const close = vi.fn();
        render(<Harness overlapping close={close} />);
        fireEvent.click(screen.getByTestId("outside-on-trigger"));
        expect(close).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText("Mute"));
        expect(close).toHaveBeenCalledTimes(1);
    });

    it("changes nothing when the submenu fits beside its menu", () => {
        const close = vi.fn();
        render(<Harness overlapping={false} close={close} />);
        fireEvent.click(screen.getByTestId("outside-elsewhere"));
        fireEvent.click(screen.getByText("Mute"));
        expect(close).not.toHaveBeenCalled();
    });
});
