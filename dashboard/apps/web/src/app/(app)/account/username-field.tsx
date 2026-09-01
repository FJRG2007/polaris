"use client";

/**
 * The username field, answered while it is being typed.
 *
 * A handle is the one field on this form that can be refused for a reason the
 * person cannot see: somebody else already has it. Left to the save, that is a
 * form they fill in, wait on, and are then told to try again with - with no idea
 * which of the names they might try would work. So the answer arrives as they
 * type, and when it is no it comes with a way out rather than only a verdict.
 *
 * The suggestions are built out of what this account already holds - the display
 * name in the field above, the two halves of their legal name, the address they
 * sign in with - because a suggestion made of somebody else's vocabulary is one
 * nobody takes. Pressing one fills the field in, which is the whole point of
 * offering them.
 *
 * Three states and they are deliberately not three colours of the same sentence.
 * Nothing is said about an empty field or one that has not changed - a handle
 * somebody already owns does not need to be congratulated on every page load.
 * A malformed one is answered by the schema's own words, which is what the save
 * would have said. Only a well-formed, free, changed handle earns a yes.
 */

import { Input, cn } from "@polaris/ui";
import { usernameField } from "@polaris/core";
import { checkUsernameAction } from "./actions";
import { Check, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** How long the field waits after the last keystroke before it asks. Long enough
 *  that typing a name is one question rather than eight. */
const ASK_AFTER_MS = 350;

type Verdict =
    | { kind: "idle" }
    | { kind: "asking" }
    | { kind: "free" }
    | { kind: "taken"; problem: string; suggestions: string[] };

export function UsernameField({
    value,
    current,
    display,
    firstName,
    lastName,
    locked,
    lockedNote,
    onChange
}: {
    value: string;
    /** The handle this account already has, which is never reported as taken. */
    current: string;
    display: string;
    firstName: string;
    lastName: string;
    locked: boolean;
    /** What to say instead of the format hint while the handle is on cooldown. */
    lockedNote: string;
    onChange: (next: string) => void;
}) {
    const [verdict, setVerdict] = useState<Verdict>({ kind: "idle" });

    // Which question an answer belongs to. Typing quickly leaves two in flight,
    // and without this the slower one lands last and reports on a handle that is
    // no longer in the field.
    const asked = useRef(0);
    // The values the request needs, off the render loop: they change on every
    // keystroke of three other fields, and rebuilding the timer for each one
    // would mean the question is never actually asked.
    const seeds = useRef({ display, firstName, lastName, current });
    seeds.current = { display, firstName, lastName, current };

    useEffect(() => {
        const wanted = value.trim().toLowerCase();
        // Nothing to say. An empty field is somebody who has not started, and
        // the handle they already have is not a question.
        if (!wanted || wanted === seeds.current.current.trim().toLowerCase()) {
            setVerdict({ kind: "idle" });
            return;
        }
        // The shape is decided here rather than by a round trip: it is the same
        // rule the server applies, it needs no database, and a field that waits
        // 350ms to be told it has a space in it feels broken.
        const shape = usernameField.safeParse(wanted);
        if (!shape.success) {
            setVerdict({
                kind: "taken",
                problem: shape.error.issues[0]?.message ?? "That username cannot be used",
                suggestions: []
            });
            return;
        }

        setVerdict({ kind: "asking" });
        const ticket = (asked.current += 1);
        const timer = setTimeout(async () => {
            const answer = await checkUsernameAction({
                username: wanted,
                display: seeds.current.display,
                firstName: seeds.current.firstName,
                lastName: seeds.current.lastName
            }).catch(() => null);
            if (ticket !== asked.current) return;
            // A check that could not be made says nothing rather than guessing.
            // The save is what decides, and claiming a name is free when nobody
            // answered would be the one wrong thing to say here.
            if (!answer || answer.error) {
                setVerdict({ kind: "idle" });
                return;
            }
            setVerdict(
                answer.free
                    ? { kind: "free" }
                    : {
                          kind: "taken",
                          problem: answer.problem || "That username is taken",
                          suggestions: answer.suggestions ?? []
                      }
            );
        }, ASK_AFTER_MS);
        return () => clearTimeout(timer);
    }, [value]);

    const taken = verdict.kind === "taken";

    return (
        <label className="flex flex-col gap-1 text-sm">
            Username
            <div className="relative">
                <Input
                    value={value}
                    placeholder="Optional"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    disabled={locked}
                    aria-describedby="username-hint"
                    aria-invalid={taken || undefined}
                    className={cn("pr-9", taken && "border-danger")}
                    onChange={(event) => onChange(event.target.value)}
                />
                {/* Inside the field, where the answer is about what is in it.
                    Nothing at all while there is no question, so a field nobody
                    has touched is not wearing a mark. */}
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                    {verdict.kind === "asking" ? (
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : verdict.kind === "free" ? (
                        <Check className="text-success size-4" />
                    ) : taken ? (
                        <X className="text-danger size-4" />
                    ) : null}
                </span>
            </div>
            <span
                id="username-hint"
                className={cn("text-xs", taken ? "text-danger" : "text-muted-foreground")}
            >
                {locked
                    ? lockedNote
                    : verdict.kind === "free"
                      ? `${value.trim().toLowerCase()} is available`
                      : taken
                        ? verdict.problem
                        : "3-30 characters: letters, numbers, - or _. Used to sign in."}
            </span>
            {taken && verdict.suggestions.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <span className="text-muted-foreground text-xs">Try</span>
                    {verdict.suggestions.map((suggestion) => (
                        <button
                            key={suggestion}
                            type="button"
                            onClick={() => onChange(suggestion)}
                            className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs transition-colors hover:border-border-strong hover:bg-card-hover"
                        >
                            {suggestion}
                        </button>
                    ))}
                </span>
            ) : null}
        </label>
    );
}
