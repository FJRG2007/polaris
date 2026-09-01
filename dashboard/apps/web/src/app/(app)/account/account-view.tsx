"use client";

/**
 * Profile self-service view: who the account is (name, username, the
 * address it signs in with and the number it can be reached on), and the
 * addresses it holds. Credentials live under Account > Security. Every change is
 * re-authorized server-side; this view only reflects the result.
 *
 * Save stays disabled until the form actually differs from what is stored, so
 * editing a field and putting it back is not offered as a change to make.
 */

import { PhoneCard } from "./phone-card";
import { UsernameField } from "./username-field";
import { EmailsView } from "./emails-view";
import { useRouter } from "next/navigation";
import { updateProfileAction } from "./actions";
import { Card, CardBody, Button, Input, Textarea } from "@polaris/ui";
import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { UserEmailView, UserPhoneView } from "@polaris/auth";

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
import { MAX_DESCRIPTION, capitalizeWords, normalizePersonName } from "@polaris/core";

type Result = { ok?: string; error?: string } | null;

interface Profile {
    /** What they are called on screen. Not their name and not their handle -
     *  see `displayNameField`. */
    name: string;
    firstName: string;
    lastName: string;
    username: string;
    description: string;
}

/** Compare the way the server stores it, so trailing space or case is not a change. */
function normalize(profile: Profile): string {
    return [
        profile.name.trim(),
        profile.firstName.trim(),
        profile.lastName.trim(),
        profile.username.trim().toLowerCase(),
        profile.description.trim()
    ].join("\n");
}

function Feedback({ result }: { result: Result }) {
    if (!result) return null;
    if (result.error) return <p className="text-sm text-danger">{result.error}</p>;
    if (result.ok) return <p className="text-sm text-success">{result.ok}</p>;
    return null;
}

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div>
                    <h2 className="text-sm font-medium">{title}</h2>
                    <p className="text-xs text-muted-foreground">{description}</p>
                </div>
                {children}
            </CardBody>
        </Card>
    );
}

export function AccountView({
    name,
    firstName,
    lastName,
    username,
    usernameChangeIn,
    description,
    emails,
    mailReady,
    phone,
    canSendWhatsApp
}: {
    name: string;
    firstName: string;
    lastName: string;
    username: string;
    /**
     * How long until a different handle may be taken - "3 days" - or undefined
     * when one may be taken now.
     *
     * A phrase rather than an instant, worked out on the server. A handle is how
     * other people address somebody, so changing it costs a wait, and the field
     * says so rather than springing it on them after they have typed a new one
     * and pressed Save. Resolved server-side because doing the arithmetic here
     * would render one answer on the server and another in the browser.
     */
    usernameChangeIn?: string;
    description: string;
    emails: UserEmailView[];
    /** Whether an email channel is configured, which decides whether an address
     *  can be verified at all. */
    mailReady: boolean;
    phone: UserPhoneView | null;
    /** Whether a WhatsApp channel is connected, which is what confirms a number. */
    canSendWhatsApp: boolean;
}) {
    const router = useRouter();
    const primary = emails.find((entry) => entry.primary)?.email ?? "";

    // The server decides for real; this is what stops somebody typing into a
    // field whose Save was never going to work.
    const usernameLocked = usernameChangeIn !== undefined;

    const stored: Profile = { name, firstName, lastName, username, description };
    const [profile, setProfile] = useState<Profile>(stored);
    const [saved, setSaved] = useState<Profile>(stored);
    const [profileBusy, setProfileBusy] = useState(false);
    const [profileResult, setProfileResult] = useState<Result>(null);

    const changed = normalize(profile) !== normalize(saved);

    async function onProfile(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setProfileBusy(true);
        setProfileResult(null);
        const result = await updateProfileAction({
            name: profile.name,
            firstName: profile.firstName,
            lastName: profile.lastName,
            username: profile.username,
            description: profile.description
        });
        setProfileBusy(false);
        setProfileResult(result.error ? result : { ok: "Profile updated." });
        if (!result.error) {
            setSaved(profile);
            router.refresh();
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <Section title="Profile" description="Your name, your username, and how you sign in.">
                <form onSubmit={onProfile} className="flex flex-col gap-3">
                    {/* First, because it is the one everybody else sees. It is
                        neither of the two fields under it: not the name on your
                        documents, not the handle you sign in with - whatever you
                        want to be called, left exactly as you typed it. */}
                    <label className="flex flex-col gap-1 text-sm">
                        Display name
                        <Input
                            value={profile.name}
                            required
                            autoComplete="nickname"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) => setProfile({ ...profile, name: event.target.value })}
                        />
                        <span className="text-xs text-muted-foreground">
                            Shown wherever your name appears. It does not have to be your name.
                        </span>
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            First name
                            <Input
                                value={profile.firstName}
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
                                    setProfile({
                                        ...profile,
                                        firstName: typedName(event)
                                    })
                                }
                                // The spacing is tidied on the way out, where a
                                // caret that moves costs nobody anything. The
                                // server does both again.
                                onBlur={() =>
                                    setProfile((current) => ({
                                        ...current,
                                        firstName: normalizePersonName(current.firstName)
                                    }))
                                }
                            />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Last name
                            <Input
                                value={profile.lastName}
                                placeholder="Optional"
                                autoComplete="family-name"
                                autoCapitalize="words"
                                autoCorrect="off"
                                spellCheck={false}
                                onChange={(event) =>
                                    setProfile({ ...profile, lastName: typedName(event) })
                                }
                                onBlur={() =>
                                    setProfile((current) => ({
                                        ...current,
                                        lastName: normalizePersonName(current.lastName)
                                    }))
                                }
                            />
                        </label>
                        {/* Said here rather than only on the privacy screen: the
                            two fields above are the one place somebody types a
                            personal detail into Polaris expecting it to be shown,
                            and it is not. */}
                        <p className="text-xs text-muted-foreground sm:col-span-2">
                            Kept for your account and shown to nobody until you say otherwise in
                            Privacy. Your display name is what appears everywhere.
                        </p>
                    </div>
                    {/* Answered while it is typed, with a way out when the name
                        is taken - see `UsernameField`. It is the one field here
                        that can be refused for a reason the person cannot see. */}
                    <UsernameField
                        value={profile.username}
                        current={username}
                        display={profile.name}
                        firstName={profile.firstName}
                        lastName={profile.lastName}
                        locked={usernameLocked}
                        lockedNote={`Other people find and address you by this, so it can only be changed once in a while. You can change it again in ${usernameChangeIn}.`}
                        onChange={(next) => setProfile({ ...profile, username: next })}
                    />
                    <label className="flex flex-col gap-1 text-sm">
                        About you
                        <Textarea
                            rows={3}
                            value={profile.description}
                            placeholder="Optional"
                            maxLength={MAX_DESCRIPTION}
                            onChange={(event) =>
                                setProfile({ ...profile, description: event.target.value })
                            }
                        />
                        <span className="text-xs text-muted-foreground">
                            Shown to anybody who opens your profile.
                        </span>
                    </label>
                    <div className="flex flex-col gap-1 text-sm">
                        Email
                        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">{primary}</p>
                        <span className="text-xs text-muted-foreground">
                            Signs you in. Change it from the addresses below.
                        </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <Feedback result={profileResult} />
                        <Button type="submit" disabled={profileBusy || !changed} className="ml-auto">
                            {profileBusy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </Section>

            <Section
                title="Email addresses"
                description="The address you sign in with, and any others this account owns."
            >
                <EmailsView emails={emails} mailReady={mailReady} />
            </Section>

            <PhoneCard phone={phone} canSend={canSendWhatsApp} />
        </div>
    );
}
