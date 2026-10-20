// @vitest-environment jsdom
/**
 * While Polar thinks it names one of its busy words, picked once per wait, and
 * every word it can pick is written in both languages.
 */

import { MessagesWrapper } from "../setup/i18n";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BusyVerb } from "@/components/polar/elements/busy-verb";
import en from "../../messages/en-US/polar.json";
import es from "../../messages/es-ES/polar.json";

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe("BusyVerb", () => {
    it("says one of the busy words and keeps it across renders", () => {
        const words = Object.values(en.busyVerbs);
        const view = render(<BusyVerb />, { wrapper: MessagesWrapper });
        const first = view.container.textContent;
        expect(words).toContain(first);
        view.rerender(<BusyVerb />);
        expect(view.container.textContent).toBe(first);
    });

    it("can reach every word, and each has a Spanish one", () => {
        const seen = new Set<string>();
        const keys = Object.keys(en.busyVerbs);
        keys.forEach((_, index) => {
            vi.spyOn(Math, "random").mockReturnValueOnce(index / keys.length);
            const view = render(<BusyVerb />, { wrapper: MessagesWrapper });
            seen.add(view.container.textContent ?? "");
            view.unmount();
        });
        expect(seen).toEqual(new Set(Object.values(en.busyVerbs)));
        expect(Object.keys(es.busyVerbs).sort()).toEqual(keys.slice().sort());
    });
});
