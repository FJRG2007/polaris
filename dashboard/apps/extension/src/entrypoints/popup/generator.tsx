/**
 * The generator's open panel: the password, what it is made of, and how long.
 *
 * Drawn from props and holding nothing that matters, so the screen can be pinned
 * in a test without a browser: which password is on it, whether it is shown,
 * and what was chosen all belong to `Generator` in `app.tsx`, which also keeps
 * the choices in storage. The only state here is the length box while somebody
 * is typing in it, which is allowed to be a number the generator would refuse
 * until they finish.
 *
 * The actions on the password are icons, like the copy mark on a login's line,
 * because at 360 pixels three labelled buttons beside a 20-character password
 * push the password onto a line of its own. Each carries its name as a label and
 * a tooltip, so neither a screen reader nor a pointer is left guessing.
 */

import { useEffect, useState } from "react";
import { AgainMark, CheckMark, CopyMark, EyeMark, FoldMark } from "./marks";
import {
    PASSWORD_MAX_LENGTH,
    PASSWORD_MIN_LENGTH,
    passwordEntropyBits
} from "@polaris/core/password-generator";
import {
    canTurnOff,
    CHARACTER_SETS,
    clampLength,
    strengthWord,
    withSet,
    type CharacterSet,
    type GeneratorOptions
} from "@/lib/generator";

/** What each set is called on its chip, and what it is called out loud. */
const SET_LABELS: Record<CharacterSet, { chip: string; name: string }> = {
    uppercase: { chip: "A-Z", name: "Uppercase letters" },
    lowercase: { chip: "a-z", name: "Lowercase letters" },
    digits: { chip: "0-9", name: "Digits" },
    symbols: { chip: "!#$", name: "Symbols" }
};

export interface GeneratorPanelProps {
    /** The password, or null when nothing can be made of the choices. */
    readonly value: string | null;
    readonly options: GeneratorOptions;
    readonly onOptions: (next: GeneratorOptions) => void;
    /** Whether the password is on screen or drawn as dots. */
    readonly shown: boolean;
    readonly onShown: (shown: boolean) => void;
    /** Whether it was just copied, for the check that replaces the copy mark. */
    readonly copied: boolean;
    readonly note: string | null;
    readonly onAgain: () => void;
    readonly onCopy: () => void;
    readonly onClose: () => void;
    /** Hand it to the save form, where there is one. */
    readonly onUse?: () => void;
}

export function GeneratorPanel({
    value,
    options,
    onOptions,
    shown,
    onShown,
    copied,
    note,
    onAgain,
    onCopy,
    onClose,
    onUse
}: GeneratorPanelProps): React.JSX.Element {
    // The box's own text, so a half-typed "1" on the way to "16" is not snapped
    // to eight under somebody's cursor. Put back to the real length when they
    // leave it, and whenever the slider moves the length from outside.
    const [typed, setTyped] = useState(String(options.length));
    useEffect(() => setTyped(String(options.length)), [options.length]);
    const typedLength = Number(typed);
    // Empty is not yet typed rather than wrong: nothing is said about it, and
    // leaving the box puts the length back.
    const typedValid =
        typed.trim() === "" ||
        (Number.isInteger(typedLength) &&
            typedLength >= PASSWORD_MIN_LENGTH &&
            typedLength <= PASSWORD_MAX_LENGTH);

    const setLength = (length: number): void => {
        if (length !== options.length) onOptions({ ...options, length });
    };

    const bits = Math.round(passwordEntropyBits(options));

    return (
        <div className="row generator">
            <div className="generated">
                <code className="value" aria-label="Generated password">
                    {value === null
                        ? "Nothing can be made of that."
                        : shown
                          ? value
                          : "•".repeat(value.length)}
                </code>
                <div className="acts">
                    <button
                        className="icon"
                        aria-label={shown ? "Hide the password" : "Show the password"}
                        title={shown ? "Hide" : "Show"}
                        disabled={value === null}
                        onClick={() => onShown(!shown)}
                    >
                        <EyeMark struck={shown} />
                    </button>
                    <button
                        className="icon"
                        aria-label="Make another password"
                        title="Make another"
                        onClick={onAgain}
                    >
                        <AgainMark />
                    </button>
                    <button
                        className={copied ? "icon copied" : "icon"}
                        aria-label={copied ? "Copied" : "Copy the password"}
                        title={copied ? "Copied" : "Copy"}
                        disabled={value === null}
                        onClick={onCopy}
                    >
                        {copied ? <CheckMark /> : <CopyMark />}
                    </button>
                </div>
            </div>

            {value !== null ? (
                <p className={`strength ${strengthWord(bits)}`}>
                    <span className="meter" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (bits / 128) * 100)}%` }} />
                    </span>
                    <span>
                        {bits} bits, {strengthWord(bits)}
                    </span>
                </p>
            ) : null}

            <div className="length">
                <label htmlFor="generator-length" className="muted small">
                    Length
                </label>
                <input
                    id="generator-length"
                    type="range"
                    min={PASSWORD_MIN_LENGTH}
                    max={PASSWORD_MAX_LENGTH}
                    value={options.length}
                    onChange={(event) => setLength(clampLength(Number(event.target.value)))}
                />
                <input
                    className="tiny"
                    type="number"
                    aria-label="Length in characters"
                    min={PASSWORD_MIN_LENGTH}
                    max={PASSWORD_MAX_LENGTH}
                    value={typed}
                    aria-invalid={!typedValid}
                    aria-describedby={typedValid ? undefined : "generator-length-hint"}
                    onChange={(event) => {
                        const next = event.target.value;
                        setTyped(next);
                        const at = Number(next);
                        if (
                            next.trim() !== "" &&
                            Number.isInteger(at) &&
                            at >= PASSWORD_MIN_LENGTH &&
                            at <= PASSWORD_MAX_LENGTH
                        ) {
                            setLength(at);
                        }
                        // Anything else waits for the box to be left, where it
                        // is brought into range rather than refused.
                    }}
                    onBlur={() => {
                        const settled = typed.trim() === "" ? options.length : clampLength(typedLength);
                        setTyped(String(settled));
                        setLength(settled);
                    }}
                />
            </div>
            {typedValid ? null : (
                <p id="generator-length-hint" className="muted small">
                    {PASSWORD_MIN_LENGTH} to {PASSWORD_MAX_LENGTH} characters.
                </p>
            )}

            <div className="chips" role="group" aria-label="Characters to use">
                {CHARACTER_SETS.map((set) => {
                    const on = options[set];
                    const locked = on && !canTurnOff(options, set);
                    return (
                        <button
                            key={set}
                            className="chip"
                            aria-pressed={on}
                            aria-label={SET_LABELS[set].name}
                            title={locked ? "At least one kind has to stay on" : SET_LABELS[set].name}
                            // Not `disabled`: a disabled button cannot show its
                            // tooltip, and the tooltip is the answer to "why won't
                            // this switch off".
                            aria-disabled={locked}
                            onClick={() => {
                                if (!locked) onOptions(withSet(options, set, !on));
                            }}
                        >
                            {SET_LABELS[set].chip}
                        </button>
                    );
                })}
                <button
                    className="chip"
                    aria-pressed={options.avoidAmbiguous}
                    aria-label="Avoid look-alike characters"
                    title="Leave out 0 and O, 1, l and I"
                    onClick={() =>
                        onOptions({ ...options, avoidAmbiguous: !options.avoidAmbiguous })
                    }
                >
                    No look-alikes
                </button>
            </div>

            <div className="generator-foot">
                {onUse ? (
                    <button
                        className="ghost"
                        title="Put it straight into a new login"
                        disabled={value === null}
                        onClick={onUse}
                    >
                        Use it
                    </button>
                ) : null}
                <button
                    className="icon fold"
                    aria-label="Close the generator"
                    title="Close"
                    onClick={onClose}
                >
                    <FoldMark />
                </button>
            </div>
            {note ? <p className="muted small">{note}</p> : null}
        </div>
    );
}
