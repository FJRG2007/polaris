"use client";

/**
 * Profile self-service view: who the account is (name, username, company, the
 * address it signs in with and the number it can be reached on), and the
 * addresses it holds. Credentials live under Account > Security. Every change is
 * re-authorized server-side; this view only reflects the result.
 *
 * Save stays disabled until the form actually differs from what is stored, so
 * editing a field and putting it back is not offered as a change to make.
 */

import { PhoneCard } from "./phone-card";
import { EmailsView } from "./emails-view";
import { useRouter } from "next/navigation";
import { updateProfileAction } from "./actions";
import { Card, CardBody, Button, Input, Textarea } from "@polaris/ui";
import { useState, type FormEvent, type ReactNode } from "react";
import type { UserEmailView, UserPhoneView } from "@polaris/auth";
import { MAX_COMPANY_LENGTH, MAX_DESCRIPTION, normalizePersonName } from "@polaris/core";

type Result = { ok?: string; error?: string } | null;

interface Profile {
    name: string;
    username: string;
    company: string;
    description: string;
}

/** Compare the way the server stores it, so trailing space or case is not a change. */
function normalize(profile: Profile): string {
    return [profile.name.trim(), profile.username.trim().toLowerCase(), profile.company.trim()].join("\n");
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
    username,
    company,
    description,
    emails,
    mailReady,
    phone,
    canSendWhatsApp
}: {
    name: string;
    username: string;
    company: string;
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

    const [profile, setProfile] = useState<Profile>({ name, username, company, description });
    const [saved, setSaved] = useState<Profile>({ name, username, company, description });
    const [profileBusy, setProfileBusy] = useState(false);
    const [profileResult, setProfileResult] = useState<Result>(null);

    const changed = normalize(profile) !== normalize(saved);

    async function onProfile(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setProfileBusy(true);
        setProfileResult(null);
        const result = await updateProfileAction({
            name: profile.name,
            username: profile.username,
            company: profile.company,
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
            <Section title="Profile" description="Your display name, username, and how you sign in.">
                <form onSubmit={onProfile} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input
                            value={profile.name}
                            required
                            autoComplete="name"
                            autoCapitalize="words"
                            autoCorrect="off"
                            spellCheck={false}
                            onChange={(event) => setProfile({ ...profile, name: event.target.value })}
                            // On blur rather than on every keystroke: normalizing as
                            // somebody types moves the caret and breaks composing a
                            // name on an IME. The server normalizes it again.
                            onBlur={() => setProfile((current) => ({ ...current, name: normalizePersonName(current.name) }))}
                        />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Username
                        <Input
                            value={profile.username}
                            placeholder="Optional"
                            autoComplete="off"
                            onChange={(event) => setProfile({ ...profile, username: event.target.value })}
                        />
                        <span className="text-xs text-muted-foreground">
                            3-32 characters: letters, numbers, and . _ - Used to sign in.
                        </span>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Company
                        <Input
                            value={profile.company}
                            placeholder="Optional"
                            maxLength={MAX_COMPANY_LENGTH}
                            autoComplete="organization"
                            onChange={(event) => setProfile({ ...profile, company: event.target.value })}
                        />
                    </label>
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
