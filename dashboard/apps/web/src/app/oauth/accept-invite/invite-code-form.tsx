"use client";

/**
 * The way in for an invite that travelled as a code rather than a link. The code
 * is checked before anything else is asked for, so somebody who mistyped it
 * finds out immediately instead of after filling in a whole profile.
 */

import { useState, type FormEvent } from "react";
import { formatInviteCode, INVITE_CODE_LENGTH, normalizeInviteCode } from "@polaris/core";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { AcceptInviteForm } from "./accept-invite-form";
import { lookupInviteCodeAction } from "./actions";

export function InviteCodeForm() {
    const [code, setCode] = useState("");
    const [invite, setInvite] = useState<{ email: string; needsPassword: boolean } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const normalized = normalizeInviteCode(code);

    async function onSubmit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await lookupInviteCodeAction(normalized);
        setPending(false);
        if (result.error || !result.invite) {
            setError(result.error ?? "That code does not match an invite.");
            return;
        }
        setInvite(result.invite);
    }

    if (invite) {
        return <AcceptInviteForm code={normalized} email={invite.email} needsPassword={invite.needsPassword} />;
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Enter your invitation code</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-3">
                        <Input
                            autoComplete="off"
                            autoFocus
                            spellCheck={false}
                            placeholder="ABCD-EFGH-JKMN"
                            aria-label="Invitation code"
                            className="text-center font-mono tracking-widest"
                            value={formatInviteCode(code)}
                            onChange={(event) => setCode(normalizeInviteCode(event.target.value))}
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || normalized.length !== INVITE_CODE_LENGTH}>
                            {pending ? "Checking..." : "Continue"}
                        </Button>
                    </form>
                    <a href="/oauth/login" className="mt-4 block text-center text-sm text-primary hover:underline">
                        Go to sign in
                    </a>
                </CardBody>
            </Card>
        </main>
    );
}
