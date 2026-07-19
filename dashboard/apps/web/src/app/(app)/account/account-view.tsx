"use client";

/**
 * Account self-service view: three independent forms (profile, email, password),
 * each with its own busy/result state so saving one never disturbs the others.
 * Every change is re-authorized server-side; this view only reflects the result.
 */

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, Button, Input } from "@polaris/ui";
import { changeEmailAction, changePasswordAction, updateProfileAction } from "./actions";

type Result = { ok?: string; error?: string } | null;

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

export function AccountView({ name, email, username }: { name: string; email: string; username: string }) {
    const router = useRouter();

    const [profileBusy, setProfileBusy] = useState(false);
    const [profileResult, setProfileResult] = useState<Result>(null);
    const [emailBusy, setEmailBusy] = useState(false);
    const [emailResult, setEmailResult] = useState<Result>(null);
    const [pwBusy, setPwBusy] = useState(false);
    const [pwResult, setPwResult] = useState<Result>(null);

    async function onProfile(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setProfileBusy(true);
        setProfileResult(null);
        const form = new FormData(event.currentTarget);
        const result = await updateProfileAction({
            name: String(form.get("name") ?? ""),
            username: String(form.get("username") ?? "")
        });
        setProfileBusy(false);
        setProfileResult(result.error ? result : { ok: "Profile updated." });
        if (!result.error) router.refresh();
    }

    async function onEmail(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        setEmailBusy(true);
        setEmailResult(null);
        const form = new FormData(event.currentTarget);
        const result = await changeEmailAction(
            String(form.get("email") ?? ""),
            String(form.get("password") ?? "")
        );
        setEmailBusy(false);
        setEmailResult(result.error ? result : { ok: "Email updated." });
        if (!result.error) {
            (event.target as HTMLFormElement).reset();
            router.refresh();
        }
    }

    async function onPassword(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const next = String(form.get("newPassword") ?? "");
        if (next !== String(form.get("confirmPassword") ?? "")) {
            setPwResult({ error: "The new passwords do not match." });
            return;
        }
        setPwBusy(true);
        setPwResult(null);
        const result = await changePasswordAction(String(form.get("currentPassword") ?? ""), next);
        setPwBusy(false);
        setPwResult(result.error ? result : { ok: "Password changed." });
        if (!result.error) (event.target as HTMLFormElement).reset();
    }

    return (
        <div className="flex flex-col gap-4">
            <Section title="Profile" description="Your display name and username.">
                <form onSubmit={onProfile} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Name
                        <Input name="name" defaultValue={name} required autoComplete="name" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Username
                        <Input name="username" defaultValue={username} placeholder="Optional" autoComplete="off" />
                        <span className="text-xs text-muted-foreground">
                            3-32 characters: letters, numbers, and . _ - Used to sign in.
                        </span>
                    </label>
                    <div className="flex items-center justify-between gap-2">
                        <Feedback result={profileResult} />
                        <Button type="submit" disabled={profileBusy} className="ml-auto">
                            {profileBusy ? "Saving..." : "Save"}
                        </Button>
                    </div>
                </form>
            </Section>

            <Section title="Email" description="Changing your email requires your current password.">
                <form onSubmit={onEmail} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        New email
                        <Input name="email" type="email" defaultValue={email} required autoComplete="email" />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="password" type="password" required autoComplete="current-password" />
                    </label>
                    <div className="flex items-center justify-between gap-2">
                        <Feedback result={emailResult} />
                        <Button type="submit" disabled={emailBusy} className="ml-auto">
                            {emailBusy ? "Updating..." : "Update email"}
                        </Button>
                    </div>
                </form>
            </Section>

            <Section title="Password" description="Use at least 10 characters.">
                <form onSubmit={onPassword} className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1 text-sm">
                        Current password
                        <Input name="currentPassword" type="password" required autoComplete="current-password" />
                    </label>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <label className="flex flex-col gap-1 text-sm">
                            New password
                            <Input name="newPassword" type="password" required autoComplete="new-password" />
                        </label>
                        <label className="flex flex-col gap-1 text-sm">
                            Confirm new password
                            <Input name="confirmPassword" type="password" required autoComplete="new-password" />
                        </label>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <Feedback result={pwResult} />
                        <Button type="submit" disabled={pwBusy} className="ml-auto">
                            {pwBusy ? "Changing..." : "Change password"}
                        </Button>
                    </div>
                </form>
            </Section>
        </div>
    );
}
