"use client";

/**
 * Who you are to everybody else: the name they read, the handle they address you
 * by, and the paragraph they get when they open your page.
 *
 * Everything on this screen is published. What is not - the name on your
 * documents, the addresses you sign in with, the number a code is sent to -
 * moved to Account, next door. That is the whole line between the two screens,
 * and it is worth keeping sharp: somebody editing their profile is deciding what
 * a colleague sees, and somebody editing their account is deciding how Polaris
 * reaches them. They are not the same act and they were not going well in one
 * form.
 *
 * Save stays disabled until the form actually differs from what is stored, so
 * editing a field and putting it back is not offered as a change to make.
 */

import { useRouter } from "next/navigation";
import { SectionCard } from "./section-card";
import { MAX_DESCRIPTION } from "@polaris/core";
import { updateProfileAction } from "./actions";
import { UsernameField } from "./username-field";
import { useState, type FormEvent } from "react";
import { Button, Input, Textarea } from "@polaris/ui";

interface Profile {
    /** What they are called on screen. Not their name and not their handle. */
    name: string;
    username: string;
    description: string;
}

/** Compare the way the server stores it, so trailing space or case is not a change. */
function normalize(profile: Profile): string {
    return [
        profile.name.trim(),
        profile.username.trim().toLowerCase(),
        profile.description.trim()
    ].join("\n");
}

export function ProfileView({
    name,
    firstName,
    lastName,
    username,
    usernameChangeIn,
    description
}: {
    name: string;
    /**
     * The name on the account, which this screen does not edit.
     *
     * Passed in anyway because a handle that is taken is answered with
     * suggestions, and the suggestions are built out of what somebody is called.
     * Leaving them out here would make the suggestions on this screen worse than
     * the ones on the screen that owns the fields.
     */
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
}) {
    const router = useRouter();

    // The server decides for real; this is what stops somebody typing into a
    // field whose Save was never going to work.
    const usernameLocked = usernameChangeIn !== undefined;

    const stored: Profile = { name, username, description };
    const [profile, setProfile] = useState<Profile>(stored);
    const [saved, setSaved] = useState<Profile>(stored);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok?: string; error?: string } | null>(null);

    const changed = normalize(profile) !== normalize(saved);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setBusy(true);
        setResult(null);
        // Only the three fields this screen owns. The action leaves anything it
        // is not sent alone, so saving here cannot write back a name the screen
        // next door has changed since this page loaded.
        const answer = await updateProfileAction({
            name: profile.name,
            username: profile.username,
            description: profile.description
        });
        setBusy(false);
        setResult(answer.error ? answer : { ok: "Profile updated." });
        if (!answer.error) {
            setSaved(profile);
            router.refresh();
        }
    }

    return (
        <SectionCard title="Profile" description="Your name, your username, and what your page says.">
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
                {/* First, because it is the one everybody else sees. It is
                    neither of the two fields on the account screen: not the name
                    on your documents, not the handle you sign in with - whatever
                    you want to be called, left exactly as you typed it. */}
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
                {/* Answered while it is typed, with a way out when the name is
                    taken - see `UsernameField`. It is the one field here that can
                    be refused for a reason the person cannot see. */}
                <UsernameField
                    value={profile.username}
                    current={username}
                    display={profile.name}
                    firstName={firstName}
                    lastName={lastName}
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
                <div className="flex items-center justify-between gap-2">
                    {result?.error ? <p className="text-sm text-danger">{result.error}</p> : null}
                    {result?.ok ? <p className="text-sm text-success">{result.ok}</p> : null}
                    <Button type="submit" disabled={busy || !changed} className="ml-auto">
                        {busy ? "Saving..." : "Save"}
                    </Button>
                </div>
            </form>
        </SectionCard>
    );
}
