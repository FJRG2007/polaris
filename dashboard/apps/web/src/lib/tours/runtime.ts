/**
 * The part of a tour that draws it. Imported on demand only - never statically -
 * so the highlighting library and its styles stay out of the first load and are
 * fetched the first time somebody starts a tour.
 */

import "./tour-theme.css";
import "driver.js/dist/driver.css";
import { driver } from "driver.js";
import type { TourStep } from "./registry";
import { buttonVariants } from "@polaris/ui";

export interface TourWords {
    readonly next: string;
    readonly previous: string;
    readonly done: string;
    readonly skip: string;
    /** "{{current}} of {{total}}", in the library's own placeholders. */
    readonly progress: string;
    readonly step: (step: TourStep) => { title: string; body: string };
}

function dress(button: HTMLButtonElement, classes: string): void {
    button.classList.remove("driver-popover-footer-btn");
    button.classList.add(...classes.split(/\s+/).filter(Boolean));
}

export interface RunningTour {
    readonly stop: () => void;
}

/**
 * Starts the given steps against the given elements. `onEnd` hears whether the
 * reader went through to the end or left early - Skip, Esc, the close button or
 * a press outside all count as leaving.
 */
export function runTour(
    steps: ReadonlyArray<{ step: TourStep; element: HTMLElement }>,
    words: TourWords,
    onEnd: (finished: boolean) => void
): RunningTour {
    let finished = false;
    const tour = driver({
        popoverClass: "polaris-tour",
        overlayColor: "#000",
        overlayOpacity: 0.5,
        stagePadding: 6,
        stageRadius: 8,
        smoothScroll: true,
        allowClose: true,
        allowKeyboardControl: true,
        showProgress: steps.length > 1,
        progressText: words.progress,
        nextBtnText: words.next,
        prevBtnText: words.previous,
        doneBtnText: words.done,
        showButtons: ["next", "previous", "close"],
        steps: steps.map(({ step, element }) => {
            const text = words.step(step);
            return {
                element,
                popover: { title: text.title, description: text.body, side: step.side }
            };
        }),
        onPopoverRender: (popover, { driver: running }) => {
            // The library's buttons, dressed as ours. Its own button class goes
            // (it resets every style), the next/previous ones stay: its click
            // handling finds the buttons by them.
            dress(popover.nextButton, buttonVariants({ variant: "primary", size: "sm" }));
            dress(popover.previousButton, buttonVariants({ variant: "secondary", size: "sm" }));
            popover.closeButton.setAttribute("aria-label", words.skip);
            popover.closeButton.title = words.skip;
            if (running.isLastStep()) return;
            const skip = document.createElement("button");
            skip.type = "button";
            skip.textContent = words.skip;
            skip.className = `${buttonVariants({ variant: "ghost", size: "sm" })} polaris-tour-skip`;
            skip.addEventListener("click", () => running.destroy());
            popover.footerButtons.prepend(skip);
        },
        onNextClick: (_element, _step, { driver: running }) => {
            if (running.isLastStep()) finished = true;
            running.moveNext();
        },
        onDestroyed: () => onEnd(finished)
    });
    tour.drive();
    return { stop: () => tour.destroy() };
}
