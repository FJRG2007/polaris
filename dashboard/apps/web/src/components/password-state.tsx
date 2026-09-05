"use client";

/**
 * What is actually true about a password, said while it is being typed.
 *
 * Two different questions that forms usually conflate. Whether it is strong is
 * arithmetic about its shape - how many characters, drawn from how large an
 * alphabet - and is answered instantly and offline. Whether it has been breached
 * is a fact about the world, answered by the corpus, and no amount of strength
 * fixes it: `Tr0ub4dor&3` is a fine-looking password that is sitting in a list.
 *
 * The breach answer is the one that matters most and is the one people are never
 * shown. It is asked with the first five characters of the password's SHA-1 and
 * nothing else, from this browser, and the count comes back with it - "seen
 * 3,730,471 times" is a sentence that changes behaviour where "weak" does not.
 *
 * Unknown is a real state and stays visible as one. The lookup fails open
 * everywhere in Polaris, and a failed check that quietly rendered as "not
 * breached" would be the one outcome that must not happen silently.
 */

import { cn } from "@polaris/ui";
import { useEffect, useState } from "react";
import { passwordBreachCount } from "@/lib/pwned-passwords";
import { rememberBreach, rememberedBreach } from "@/lib/breach-cache";
import { ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";

/** Long enough that the corpus is not asked about every keystroke. */
const DEBOUNCE_MS = 500;

/** The shortest password worth asking the corpus about. Under this the answer is
 *  always "yes" and says nothing. */
const MIN_ASKED = 8;

/** How the strength reads, in words rather than a bar: a bar says "more" and a
 *  word says what to do. */
const WORDS = ["Very weak", "Weak", "Fair", "Strong", "Fantastic"] as const;

/**
 * How much guessing this password would take, in bits, and the word for it.
 *
 * The usual entropy estimate - length times the log of the alphabet it draws
 * from - which is honest about what it measures: it knows nothing about
 * `Password1!` being a famous password, and that is exactly what the breach
 * check is for. The two answers are shown side by side because neither is the
 * whole truth on its own.
 */
export function passwordStrength(password: string): { bits: number; word: (typeof WORDS)[number] } {
    if (!password) return { bits: 0, word: WORDS[0] };
    const alphabet =
        (/[a-z]/.test(password) ? 26 : 0) +
        (/[A-Z]/.test(password) ? 26 : 0) +
        (/\d/.test(password) ? 10 : 0) +
        (/[^\w\s]/.test(password) ? 33 : 0) +
        (/\s/.test(password) ? 1 : 0);
    const bits = alphabet > 1 ? Math.round(password.length * Math.log2(alphabet)) : 0;
    const word = bits >= 100 ? WORDS[4] : bits >= 75 ? WORDS[3] : bits >= 55 ? WORDS[2] : bits >= 35 ? WORDS[1] : WORDS[0];
    return { bits, word };
}

export type BreachState = "unknown" | "checking" | "clear" | "breached";

/**
 * Whether the corpus knows this password, and how many times.
 *
 * Debounced, with the in-flight request abandoned the moment the password
 * changes - so an answer about a password three characters old can never land on
 * the current one.
 *
 * A saved item passes its id as the scope, and then the answer is remembered for
 * a month rather than asked for again every time the item is opened - see
 * `breach-cache`, where what is written down and what deliberately is not is the
 * whole of the design. Without a scope nothing is kept: a password being typed
 * into a form is asked about once and forgotten.
 */
export function usePasswordBreach(
    password: string,
    scope?: string
): { state: BreachState; count: number } {
    const [answer, setAnswer] = useState<{ state: BreachState; count: number }>({
        state: "unknown",
        count: 0
    });

    useEffect(() => {
        if (password.length < MIN_ASKED) {
            setAnswer({ state: "unknown", count: 0 });
            return;
        }
        // Answered from what this machine already knows, with no request and no
        // "checking..." in between - which is what makes opening an item feel
        // like reading a record rather than running one.
        const known = scope ? rememberedBreach(scope, password) : null;
        if (known !== null) {
            setAnswer({ state: known > 0 ? "breached" : "clear", count: known });
            return;
        }
        setAnswer({ state: "checking", count: 0 });
        const controller = new AbortController();
        const timer = setTimeout(() => {
            void passwordBreachCount(password, controller.signal).then((count) => {
                if (controller.signal.aborted) return;
                // Null is "could not ask", which is not "safe" and is not drawn
                // as it - nor written down, since an outage must not become a
                // month of silence.
                if (count === null) {
                    setAnswer({ state: "unknown", count: 0 });
                    return;
                }
                setAnswer({ state: count > 0 ? "breached" : "clear", count });
                if (scope) rememberBreach(scope, password, count);
            });
        }, DEBOUNCE_MS);
        return () => {
            controller.abort();
            clearTimeout(timer);
        };
    }, [password, scope]);

    return answer;
}

/**
 * The line under a password box: how strong it is, and whether it is public.
 *
 * Drawn as one line rather than two rows of chrome. It is a caption, not a
 * dashboard - the point is that somebody reads it without being asked to.
 */
export function PasswordState({
    password,
    scope,
    className
}: {
    password: string;
    /** The id of the item this password belongs to, where there is one. Its
     *  breach answer is then kept for a month instead of being asked for on
     *  every visit. */
    scope?: string;
    className?: string;
}) {
    const breach = usePasswordBreach(password, scope);
    const strength = passwordStrength(password);
    if (!password) return null;

    return (
        <span className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", className)}>
            <span className="flex items-center gap-1">
                <span
                    aria-hidden="true"
                    className={cn(
                        "size-2 rounded-full",
                        strength.bits >= 75
                            ? "bg-success"
                            : strength.bits >= 55
                              ? "bg-warning"
                              : "bg-danger"
                    )}
                />
                <span className="text-muted-foreground">{strength.word}</span>
            </span>

            {breach.state === "breached" ? (
                <span className="flex items-center gap-1 text-danger">
                    <ShieldAlert className="size-3.5 shrink-0" />
                    {/* The number, because it is what changes behaviour. "Weak"
                        is an opinion; "seen 3,730,471 times" is not. */}
                    Found in breaches {breach.count.toLocaleString()} times
                </span>
            ) : breach.state === "clear" ? (
                <span className="flex items-center gap-1 text-success">
                    <ShieldCheck className="size-3.5 shrink-0" />
                    Not in any known breach
                </span>
            ) : breach.state === "checking" ? (
                <span className="text-muted-foreground">Checking breaches...</span>
            ) : password.length >= MIN_ASKED ? (
                <span className="flex items-center gap-1 text-muted-foreground">
                    <ShieldQuestion className="size-3.5 shrink-0" />
                    Breach check unavailable
                </span>
            ) : null}
        </span>
    );
}
