// @vitest-environment jsdom
/**
 * The popup's words, followed while it is open.
 *
 * The words are a function, and a function handed straight to a state setter is
 * called by React as an updater - with the old words as its "key". The popup
 * went blank the moment an account in another language connected while it was
 * open. This mounts the provider, changes the language under it, and reads what
 * it draws.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { WordsProvider, useWords } from "../src/entrypoints/popup/words";

function Title(): React.JSX.Element {
    const t = useWords();
    return <p>{t("shell.servers")}</p>;
}

afterEach(cleanup);

describe("the popup's words", () => {
    it("redraws in the account's language when it changes with the popup open", () => {
        let change: (stored: string | null) => void = () => {};
        render(
            <WordsProvider
                initial="en-US"
                follow={(onChange) => {
                    change = onChange;
                    return () => {};
                }}
            >
                <Title />
            </WordsProvider>
        );
        expect(screen.getByText("Servers")).toBeTruthy();
        act(() => change("es-ES"));
        expect(screen.getByText("Servidores")).toBeTruthy();
    });
});
