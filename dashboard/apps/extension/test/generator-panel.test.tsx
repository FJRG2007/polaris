/**
 * The generator's open panel: the password with its three actions as icons that
 * say what they do, the length as a slider and a box, the kinds of character as
 * switches that report their state, and a strength line.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GENERATOR_DEFAULTS, type GeneratorOptions } from "../src/lib/generator";
import { GeneratorPanel, type GeneratorPanelProps } from "../src/entrypoints/popup/generator";

const VALUE = "abcDEF123!#$ghiJKL45";

function panel(overrides: Partial<GeneratorPanelProps> = {}): string {
    return renderToStaticMarkup(
        <GeneratorPanel
            value={VALUE}
            options={GENERATOR_DEFAULTS}
            onOptions={() => {}}
            shown={true}
            onShown={() => {}}
            copied={false}
            note={null}
            onAgain={() => {}}
            onCopy={() => {}}
            onClose={() => {}}
            {...overrides}
        />
    );
}

describe("the password and its actions", () => {
    it("shows the password, and dots when it is hidden", () => {
        expect(panel()).toContain(VALUE);
        const hidden = panel({ shown: false });
        expect(hidden).not.toContain(VALUE);
        expect(hidden).toContain("•".repeat(VALUE.length));
        expect(hidden).toContain('aria-label="Show the password"');
        expect(panel()).toContain('aria-label="Hide the password"');
    });

    it("names every icon action with a label and a tooltip", () => {
        const markup = panel();
        for (const [label, title] of [
            ["Copy the password", "Copy"],
            ["Make another password", "Make another"],
            ["Close the generator", "Close"]
        ]) {
            expect(markup).toContain(`aria-label="${label}" title="${title}"`);
        }
        // Icons, not the words the old buttons carried.
        expect(markup).not.toContain(">Again<");
        expect(markup).not.toContain(">Copy<");
        expect(markup).not.toContain(">Hide<");
    });

    it("turns the copy mark into a check once copied", () => {
        const markup = panel({ copied: true });
        expect(markup).toContain('aria-label="Copied"');
        expect(markup).toContain("copy-mark done");
    });

    it("offers Use it only where there is a form to hand the password to", () => {
        expect(panel()).not.toContain("Use it");
        expect(panel({ onUse: () => {} })).toContain("Use it");
    });

    it("says so when nothing can be made, and offers nothing to copy", () => {
        const markup = panel({ value: null });
        expect(markup).toContain("Nothing can be made of that.");
        expect(markup).toMatch(/<button[^>]*aria-label="Copy the password"[^>]*disabled=""/);
    });
});

describe("the choices", () => {
    it("draws the length as a slider and a box over the generator's range", () => {
        const markup = panel();
        expect(markup).toMatch(/type="range" min="8" max="128"[^>]*value="20"/);
        expect(markup).toMatch(/type="number"[^>]*min="8" max="128"[^>]*value="20"/);
    });

    it("reports each kind of character as a switch that is on or off", () => {
        const options: GeneratorOptions = { ...GENERATOR_DEFAULTS, symbols: false };
        const markup = panel({ options });
        expect(markup).toContain('aria-pressed="true" aria-label="Uppercase letters"');
        expect(markup).toContain('aria-pressed="false" aria-label="Symbols"');
        expect(markup).toContain('aria-pressed="false" aria-label="Avoid look-alike characters"');
    });

    it("holds the last kind on, and says why", () => {
        const options: GeneratorOptions = {
            ...GENERATOR_DEFAULTS,
            lowercase: false,
            uppercase: false,
            symbols: false
        };
        const markup = panel({ options });
        expect(markup).toContain(
            'aria-pressed="true" aria-label="Digits" title="At least one kind has to stay on" aria-disabled="true"'
        );
    });

    it("gives a strength figure for the choices", () => {
        // 20 characters from 75: about 125 bits.
        expect(panel()).toContain("125 bits, strong");
        expect(
            panel({
                options: {
                    ...GENERATOR_DEFAULTS,
                    length: 8,
                    uppercase: false,
                    digits: false,
                    symbols: false
                }
            })
        ).toContain("38 bits, weak");
    });
});
