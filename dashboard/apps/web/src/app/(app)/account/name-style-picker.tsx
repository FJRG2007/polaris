"use client";

/**
 * Choosing how a display name is painted, and what it is set in.
 *
 * Two pickers rather than one, because they are two questions and people arrive
 * with only one of them: "I want my name in that handwriting" is asked far more
 * often than "I want my name to be a gradient", and burying the faces inside the
 * colour controls meant the first question could only be answered by first
 * answering the second. So the effect and the letterforms are separate sections
 * of the card, and either can be left alone.
 *
 * They still write one value. A name style is a single column - `effect:font:
 * colours` - read and written whole, so a new effect or a new face is an entry
 * in a list rather than a migration on a table every account has a row in. Both
 * pickers therefore compose the WHOLE look every time, and neither can leave the
 * value half-changed.
 *
 * Every button is drawn in the thing it selects: the word "Neon" glows, "Comic"
 * is set in the comic face. The alternative is a column of nouns somebody has to
 * try one at a time to find out what they mean, and "Bungee" means nothing to
 * anybody who has not already seen it.
 */

import * as core from "@polaris/core";
import { ColorPicker } from "@polaris/ui";
import { Choice } from "./appearance-choice";
import { nameLookCss, nameStyleClass } from "@/lib/profile-style-css";

/** What each effect is called on the button it paints. */
const EFFECT_LABELS: Record<core.NameEffect, string> = {
    plain: "None",
    solid: "Solid",
    gradient: "Gradient",
    neon: "Neon",
    toon: "Toon",
    pop: "Pop",
    gummy: "Gummy",
    prism: "Prism"
};

const FONT_LABELS: Record<core.NameFont, string> = {
    sans: "Default",
    caps: "Small caps",
    serif: "Serif",
    mono: "Mono",
    rounded: "Rounded",
    hand: "Handwritten",
    comic: "Comic",
    script: "Script",
    block: "Block",
    bubble: "Bubble",
    techno: "Techno",
    pixel: "Pixel"
};

/** Where a name starts when somebody turns one on, so the first thing they see
 *  is a painted name rather than black on black. */
const FIRST_INK = "#5b8def";
const SECOND_INK = "#a06bff";

/** The stored value as the four things the two pickers edit, with the defaults
 *  a name that has never been styled starts from. */
function read(value: string | null) {
    const look = core.nameLookOf(value);
    return {
        effect: look?.effect ?? "plain",
        font: look?.font ?? "sans",
        first: look?.colors[0] ?? FIRST_INK,
        second: look?.colors[1] ?? SECOND_INK
    };
}

/**
 * The whole look as one value - or nothing at all.
 *
 * No paint and the default face is not a style, it is the absence of one, and it
 * has to be stored as the absence of one: a row saying `plain:sans:#5b8def`
 * would be a name that reads as customised everywhere the two are compared, and
 * a colour kept against a name nobody chose to colour.
 */
function compose(effect: core.NameEffect, font: core.NameFont, colors: string[]): string | null {
    if (effect === "plain" && font === "sans") return null;
    return core.writeNameLook({ effect, font, colors, moving: false });
}

export function NameEffectPicker({
    value,
    onChange
}: {
    value: string | null;
    onChange: (next: string | null) => void;
}) {
    const { effect, font, first, second } = read(value);
    const put = (next: core.NameEffect, colors: string[] = [first, second]) =>
        onChange(compose(next, font, colors));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-1.5">
                {core.NAME_EFFECTS.map((entry) => (
                    <Choice
                        key={entry}
                        chosen={effect === entry}
                        onClick={() => put(entry)}
                        label={EFFECT_LABELS[entry]}
                        // Painted as the thing it selects, in the colours
                        // already chosen and the face already chosen, so the
                        // choice is made by looking rather than by guessing.
                        labelClass={nameStyleClass({ moving: entry === "prism" })}
                        style={nameLookCss({
                            effect: entry,
                            font,
                            colors: [first, second],
                            moving: entry === "prism"
                        })}
                    />
                ))}
            </div>

            {/* Only where there is paint to choose the colour of. Two pickers
                under "None" are two controls that change nothing, which is worse
                than two that are not there. */}
            {core.effectTakesColor(effect) ? (
                <div className="flex flex-wrap items-center gap-3">
                    <ColorPicker
                        label={core.effectTakesTwo(effect) ? "From" : "Colour"}
                        value={first}
                        onChange={(next) => put(effect, [next, second])}
                    />
                    {core.effectTakesTwo(effect) ? (
                        <ColorPicker
                            label="To"
                            value={second}
                            onChange={(next) => put(effect, [first, next])}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

export function NameFontPicker({
    value,
    onChange
}: {
    value: string | null;
    onChange: (next: string | null) => void;
}) {
    const { effect, font, first, second } = read(value);

    return (
        <div className="flex flex-wrap gap-1.5">
            {core.NAME_FONTS.map((entry) => (
                <Choice
                    key={entry}
                    chosen={font === entry}
                    onClick={() => onChange(compose(effect, entry, [first, second]))}
                    label={FONT_LABELS[entry]}
                    // Set in the face it selects and in no colour of its own:
                    // this row answers "what does my name look like", and a row
                    // of eleven words in eleven colours answers a question
                    // nobody asked here.
                    style={nameLookCss({
                        effect: "plain",
                        font: entry,
                        colors: [first],
                        moving: false
                    })}
                />
            ))}
        </div>
    );
}
