"use client";

/**
 * Moving a shortcut.
 *
 * Each command shows the key it answers to now. Pressing Change listens for the
 * next key, which is how every keyboard settings screen works and the only way
 * that is not a text box somebody types "Esc" into. The key is checked as it
 * is pressed - one key, nothing held down, not one of the keys every list is
 * driven by, and not a key another command already has - and a refusal names
 * the command that is in the way, so the fix is obvious.
 *
 * Nothing is written until Save, and Save only lights up when the keyboard on
 * the form differs from the one stored: a key moved and moved back is no change.
 */

import * as core from "@polaris/core";
import { Button, cn, useToast } from "@polaris/ui";
import { refusalOf } from "@/app/(app)/mail/refusal";
import { useMemo, useState, useTransition, type KeyboardEvent } from "react";
import { setMailKeysAction } from "@/app/(app)/mail/actions";

/** Two keymaps are the same keyboard when every command lands on the same key. */
function sameKeyboard(left: core.MailKeymap, right: core.MailKeymap): boolean {
    return core.MAIL_REBINDABLE_COMMANDS.every(
        (command) => core.mailKeyFor(command, left) === core.mailKeyFor(command, right)
    );
}

/** A keymap with a command put back on its default, which is stored as absence. */
function without(keymap: core.MailKeymap, command: core.MailKeyCommand): core.MailKeymap {
    const next: Partial<Record<core.MailKeyCommand, string>> = { ...keymap };
    delete next[command];
    return next;
}

export function ShortcutsView({ keymap }: { keymap: core.MailKeymap }) {
    const toast = useToast();
    const [saving, startSaving] = useTransition();
    const [stored, setStored] = useState<core.MailKeymap>(keymap);
    const [held, setHeld] = useState<core.MailKeymap>(keymap);
    const [recording, setRecording] = useState<core.MailKeyCommand | null>(null);
    const [problem, setProblem] = useState<{ command: core.MailKeyCommand; message: string } | null>(
        null
    );

    const changed = useMemo(() => !sameKeyboard(held, stored), [held, stored]);
    const moved = core.MAIL_REBINDABLE_COMMANDS.some(
        (command) => core.mailKeyFor(command, held) !== core.MAIL_KEY_DEFINITIONS[command].key
    );

    /** Take the key just pressed for a command, or say why not. */
    function take(command: core.MailKeyCommand, event: KeyboardEvent): void {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "Escape") {
            setRecording(null);
            setProblem(null);
            return;
        }
        // Shift on its own is how `!`, `#` and `?` are typed, so it is not a
        // modifier here; the others belong to the browser and never reach Mail.
        if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) {
            setProblem({ command, message: "Use one key with nothing held down." });
            return;
        }
        if (!core.isBindableMailKey(event.key)) {
            setProblem({
                command,
                message: "That key cannot be used. Enter, Escape, the arrows, Delete and Backspace keep their own jobs."
            });
            return;
        }
        const next =
            event.key === core.MAIL_KEY_DEFINITIONS[command].key
                ? without(held, command)
                : { ...held, [command]: event.key };
        const clash = core.mailKeyConflicts(next).get(event.key)?.find((other) => other !== command);
        if (clash) {
            setProblem({
                command,
                message: `${core.mailKeyLabel(event.key)} already does "${core.MAIL_KEY_DEFINITIONS[clash].label.toLowerCase()}". Move that one first.`
            });
            return;
        }
        setHeld(next);
        setRecording(null);
        setProblem(null);
    }

    function save(): void {
        startSaving(async () => {
            const answer = await setMailKeysAction(held);
            const said = refusalOf(answer);
            if (said) {
                toast.show({ title: said });
                return;
            }
            if ("keys" in answer && answer.keys) {
                setStored(answer.keys);
                setHeld(answer.keys);
            }
            toast.show({ title: "Saved. The new keys work the next time you open a list." });
        });
    }

    return (
        <div className="space-y-5">
            <p className="max-w-prose text-[13px] text-muted-foreground">
                Press Change, then the key you want. Keys that already do something else are
                refused, so nothing ends up doing two things.
            </p>

            <ul className="divide-y divide-border rounded-md border border-border">
                {core.MAIL_REBINDABLE_COMMANDS.map((command) => {
                    const definition = core.MAIL_KEY_DEFINITIONS[command];
                    const key = core.mailKeyFor(command, held);
                    const listening = recording === command;
                    const wrong = problem?.command === command ? problem.message : "";
                    return (
                        <li key={command} className="flex flex-wrap items-center gap-3 px-3 py-2">
                            <div className="min-w-0 flex-1">
                                <span className="block text-[13px]">{definition.label}</span>
                                {definition.fixed.length > 0 ? (
                                    <span className="block text-[12px] text-foreground-subtle">
                                        Also {definition.fixed.map(core.mailKeyLabel).join(" and ")},
                                        which do not move
                                    </span>
                                ) : null}
                                {wrong ? (
                                    <span role="alert" className="block text-[12px] text-danger">
                                        {wrong}
                                    </span>
                                ) : null}
                            </div>
                            <kbd
                                className={cn(
                                    "min-w-8 rounded border border-border bg-card px-2 py-0.5 text-center font-mono text-[12px]",
                                    key !== definition.key && "border-primary/50"
                                )}
                            >
                                {core.mailKeyLabel(key)}
                            </kbd>
                            <Button
                                variant={listening ? "secondary" : "ghost"}
                                size="sm"
                                aria-label={
                                    listening
                                        ? `Press a key for ${definition.label.toLowerCase()}, or Escape to cancel`
                                        : `Change the key for ${definition.label.toLowerCase()}`
                                }
                                onClick={() => {
                                    setProblem(null);
                                    setRecording(listening ? null : command);
                                }}
                                onKeyDown={listening ? (event) => take(command, event) : undefined}
                                onBlur={() => {
                                    if (listening) setRecording(null);
                                }}
                            >
                                {listening ? "Press a key..." : "Change"}
                            </Button>
                            {key !== definition.key ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        setHeld((current) => without(current, command));
                                        setProblem(null);
                                    }}
                                >
                                    Reset
                                </Button>
                            ) : null}
                        </li>
                    );
                })}
            </ul>

            <div className="flex flex-wrap items-center gap-3">
                <Button disabled={saving || !changed} onClick={save}>
                    {saving ? "Saving..." : "Save"}
                </Button>
                <Button
                    variant="ghost"
                    disabled={saving || !moved}
                    onClick={() => {
                        setHeld({});
                        setProblem(null);
                    }}
                >
                    Put every key back
                </Button>
                {changed ? (
                    <span className="text-[12px] text-muted-foreground">Not saved yet.</span>
                ) : null}
            </div>
        </div>
    );
}
