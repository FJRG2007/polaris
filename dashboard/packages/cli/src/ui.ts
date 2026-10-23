/**
 * Asking and telling a person at the terminal: framed prompts, a spinner while
 * something runs, results in a note.
 *
 * Only ever when somebody is there to see it. With stdout or stdin not a
 * terminal, `--json`, `--yes` or `CI` set, `fancy` answers null and a command
 * prints exactly what it printed before this existed - scripts parse that, and
 * `test/plain` holds it to the byte. Every question asked here has a flag or an
 * argument that answers it instead.
 *
 * Drawn by @clack/prompts, loaded only when a prompt is about to be shown, so
 * `plr --help` and every scripted run never evaluate it.
 */

import { CliError } from "./errors.js";
import type { Flags } from "./args.js";
import type { Context } from "./context.js";

export interface Choice<Value> {
    readonly value: Value;
    readonly label: string;
    readonly hint?: string;
}

export interface Spinner {
    start(message: string): void;
    message(message: string): void;
    stop(message: string): void;
    error(message: string): void;
}

/** Everything a command may ask or tell. A prompt the person abandons
 *  (Ctrl+C, Esc) throws `Cancelled` rather than answering. */
export interface Ui {
    intro(title: string): void;
    outro(message: string): void;
    note(body: string, title?: string): void;
    info(message: string): void;
    success(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    select<Value>(message: string, choices: readonly Choice<Value>[]): Promise<Value>;
    confirm(message: string, initial?: boolean): Promise<boolean>;
    /** `validate` returns the sentence to show under the field, or undefined. */
    text(
        message: string,
        options?: {
            placeholder?: string;
            initial?: string;
            validate?: (value: string) => string | undefined;
        }
    ): Promise<string>;
    password(message: string): Promise<string>;
    spinner(): Spinner;
}

/** A prompt the person walked away from. Already said on screen, so `main`
 *  prints nothing more; 130 is the exit code a shell gives an interrupt. */
export class Cancelled extends CliError {
    readonly quiet = true;

    constructor() {
        super("Cancelled.", 130);
        this.name = "Cancelled";
    }
}

/** Whether the CI variable means a CI run: set, and not "false" or "0". */
export function inCi(env: NodeJS.ProcessEnv): boolean {
    const value = env.CI?.trim().toLowerCase();
    return value !== undefined && value !== "" && value !== "false" && value !== "0";
}

/** The prompts for this command, or null when it must print plainly. */
export async function fancy(context: Context, flags: Flags): Promise<Ui | null> {
    if (!context.ui || !context.io.interactive) return null;
    if (flags.json || flags.yes || inCi(context.host.env)) return null;
    return context.ui();
}

/** The real prompts, drawn by @clack/prompts. */
export async function clackUi(): Promise<Ui> {
    const p = await import("@clack/prompts");
    const answered = <Value>(value: Value): Exclude<Value, symbol> => {
        if (p.isCancel(value)) {
            p.cancel("Cancelled. Nothing was changed.");
            throw new Cancelled();
        }
        return value as Exclude<Value, symbol>;
    };
    return {
        intro: (title) => p.intro(title),
        outro: (message) => p.outro(message),
        note: (body, title) => p.note(body, title),
        info: (message) => p.log.info(message),
        success: (message) => p.log.success(message),
        warn: (message) => p.log.warn(message),
        error: (message) => p.log.error(message),
        async select(message, choices) {
            const options = choices.map((choice) => ({
                value: choice.value,
                label: choice.label,
                hint: choice.hint
            }));
            // The option type is conditional on the value's type; the shape
            // above is valid for every one of them.
            return answered(
                await p.select({ message, options: options as never, maxItems: 12 })
            ) as never;
        },
        async confirm(message, initial = false) {
            return answered(await p.confirm({ message, initialValue: initial }));
        },
        async text(message, options = {}) {
            const { validate } = options;
            return answered(
                await p.text({
                    message,
                    placeholder: options.placeholder,
                    initialValue: options.initial,
                    validate: validate ? (value) => validate(value ?? "") : undefined
                })
            );
        },
        async password(message) {
            return answered(await p.password({ message }));
        },
        spinner() {
            const spin = p.spinner();
            return {
                start: (message) => spin.start(message),
                message: (message) => spin.message(message),
                stop: (message) => spin.stop(message),
                error: (message) => spin.error(message)
            };
        }
    };
}

/** A result: a success line in the frame, or the plain line scripts read. */
export function report(context: Context, ui: Ui | null, text: string): void {
    if (ui) ui.success(text);
    else context.io.out(text.endsWith("\n") ? text : `${text}\n`);
}

/** Run `work` under a spinner: `done` names what finished, and a failure stops
 *  the spinner with `failed` before it is reported. */
export async function spinning<Result>(
    ui: Ui,
    messages: { start: string; done: (result: Result) => string; failed: string },
    work: () => Promise<Result>
): Promise<Result> {
    const spin = ui.spinner();
    spin.start(messages.start);
    try {
        const result = await work();
        spin.stop(messages.done(result));
        return result;
    } catch (caught) {
        spin.error(messages.failed);
        throw caught;
    }
}
