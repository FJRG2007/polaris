"use client";

/**
 * The account behind the profile: the name on it, the addresses it signs in and
 * is reached at, and the number a code goes to.
 *
 * None of this is published. That is the whole reason it is a screen of its own
 * rather than three more cards under the profile: on the profile every field is
 * a decision about what a colleague sees, and here every field is a decision
 * about how Polaris reaches you. Mixing them made one long form where the
 * consequence of a field changed halfway down, with the only warning a line of
 * small grey text.
 *
 * Credentials, sessions and second factors are not here either - they are their
 * own screens under Security, for the same reason.
 *
 * Save stays disabled until the form actually differs from what is stored, so
 * editing a field and putting it back is not offered as a change to make.
 */

import { PhoneCard } from "../phone-card";
import { useRouter } from "next/navigation";
import { EmailsView } from "../emails-view";
import { Button, Input } from "@polaris/ui";
import { SectionCard } from "../section-card";
import { updateProfileAction } from "../actions";
import type { UserEmailView, UserPhoneView } from "@polaris/auth";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { capitalizeWords, normalizePersonName } from "@polaris/core";

/**
 * What a name field should hold after one keystroke.
 *
 * Capitalized as it is typed, because every word of a person's name is
 * capitalized and correcting it only when they leave the field means watching
 * their own name be typed wrong and then quietly fixed. It never changes the
 * length of what was typed, so the caret does not move.
 *
 * Except mid-composition. An IME builds a word out of several keystrokes and
 * publishes an unfinished string on each one; rewriting that string is how a
 * Japanese or Korean name comes out mangled. Those are left alone and the blur
 * catches them, which is what every field that does this has to do.
 */
function typedName(event: ChangeEvent<HTMLInputElement>): string {
    const typed = event.target.value;
    const composing = (event.nativeEvent as { isComposing?: boolean }).isComposing === true;
    return composing ? typed : capitalizeWords(typed);
}

interface Named {
    firstName: string;
    lastName: string;
}

/** Compare the way the server stores it, so trailing space is not a change. */
function normalize(named: Named): string {
    return [named.firstName.trim(), named.lastName.trim()].join("\n");
}

export function AccountView({
    firstName,
    lastName,
    emails,
    mailReady,
    phone,
    canSendWhatsApp
}: {
    firstName: string;
    lastName: string;
    emails: UserEmailView[];
    /** Whether an email channel is configured, which decides whether an address
     *  can be verified at all. */
    mailReady: boolean;
    phone: UserPhoneView | null;
    /** Whether a WhatsApp channel is connected, which is what confirms a number. */
    canSendWhatsApp: boolean;
}) {
    const router = useRouter();

    const stored: Named = { firstName, lastName };
    const [named, setNamed] = useState<Named>(stored);
    const [saved, setSaved] = useState<Named>(stored);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);

    const changed = normalize(named) !== normalize(saved);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setResult(null);
        // Only the two fields this screen owns, so saving here cannot write back
        // a display name the profile screen has changed since this page loaded.
        const answer = await updateProfileAction({
            firstName: named.firstName,
            lastName: named.lastName
        });
        setBusy(false);
        setResult(answer.error ? answer : { ok: "Account updated." });
        if (!answer.error) {
            setSaved(named);
            router.refresh();
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <SectionCard
                title="Your name"
                description="Held on the account. Not what other people see, unless you say so in Privacy."
            >
                <form onSubmit={onSubmit} className="flex flex-col gap-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            First name
                            <Input
                                value={named.firstName}
                                placeholder="Optional"
                                autoComplete="given-name"
                                autoCapitalize="words"
                                autoCorrect="off"
                                spellCheck={false}
                                // Capitalized as it is typed. It cannot change the
                                // length of what was typed, so the caret stays
                                // where it was - which is why this is safe here
                                // and the trimming below is not.
                                onChange={(event) =>
                                    setNamed({ ...named, firstName: typedName(event) })
                                }
                                // The spacing is tidied on the way out, where a
                                // caret that moves costs nobody anything. The
                                // server does both again.
                                onBlur={() =>
                                    setNamed((current) => ({
                                        ...current,
                                        firstName: normalizePersonName(current.firstName)
                                    }))
                                }
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Last name
                            <Input
                                value={named.lastName}
                                placeholder="Optional"
                                autoComplete="family-name"
                                autoCapitalize="words"
                                autoCorrect="off"
                                spellCheck={false}
                                onChange={(event) =>
                                    setNamed({ ...named, lastName: typedName(event) })
                                }
                                onBlur={() =>
                                    setNamed((current) => ({
                                        ...current,
                                        lastName: normalizePersonName(current.lastName)
                                    }))
                                }
                            />
                        </label>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        {result?.error ? <p className="text-sm text-danger">{result.error}</p> : null}
                        {result?.ok ? <p className="text-sm text-success">{result.ok}</p> : null}
                        <Button type="submit" disabled={busy || !changed} className="ml-auto">
                            {busy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </SectionCard>

            <SectionCard
                title="Email addresses"
                description="The address you sign in with, and any others this account owns."
            >
                <EmailsView emails={emails} mailReady={mailReady} />
            </SectionCard>

            <PhoneCard phone={phone} canSend={canSendWhatsApp} />
        </div>
    );
}
