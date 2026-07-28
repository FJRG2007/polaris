"use client";

/**
 * The second-factor challenge, reached when sign-in returns twoFactorRedirect.
 * At this point better-auth holds a short-lived challenge cookie and no session
 * exists yet, so the verification runs through its browser client - the one that
 * owns that cookie - and a success is what finally issues the session.
 *
 * Backup codes share the screen because the moment a user needs one is the moment
 * they cannot reach their authenticator, and sending them elsewhere to find it
 * would be exactly the wrong time.
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardBody, CardHeader, CardTitle, Checkbox, Input, PolarisMark } from "@polaris/ui";
import { authClient } from "@/lib/auth-client";

/** Post-verification destination: a safe same-origin redirect, else the drive. */
function target(): string {
    const redirect = new URLSearchParams(window.location.search).get("redirect");
    return redirect && redirect.startsWith("/") && !redirect.startsWith("//") ? redirect : "/drive";
}

export default function TwoFactorPage() {
    const router = useRouter();
    const [mode, setMode] = useState<"totp" | "backup">("totp");
    const [trustDevice, setTrustDevice] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function onSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();
        const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
        setPending(true);
        setError(null);
        const { error: verifyError } =
            mode === "totp"
                ? await authClient.twoFactor.verifyTotp({ code, trustDevice })
                : await authClient.twoFactor.verifyBackupCode({ code });
        setPending(false);
        if (verifyError) {
            setError(mode === "totp" ? "That code is not valid." : "That backup code is not valid.");
            return;
        }
        router.push(target());
        router.refresh();
    }

    return (
        <main className="grid min-h-screen place-items-center p-4">
            <Card className="w-full max-w-sm">
                <CardHeader className="items-center">
                    <PolarisMark className="mb-1" />
                    <CardTitle>Two-step verification</CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1 text-sm">
                            {mode === "totp" ? "Code from your authenticator" : "Backup code"}
                            <Input
                                name="code"
                                autoFocus
                                autoComplete="one-time-code"
                                inputMode={mode === "totp" ? "numeric" : "text"}
                                placeholder={mode === "totp" ? "000000" : "XXXXXXXX"}
                                required
                            />
                        </label>
                        {mode === "totp" ? (
                            <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                    checked={trustDevice}
                                    onChange={(event) => setTrustDevice(event.target.checked)}
                                />
                                Trust this device for 30 days
                            </label>
                        ) : null}
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending}>
                            {pending ? "Verifying..." : "Verify"}
                        </Button>
                    </form>
                    <button
                        type="button"
                        className="mt-4 w-full text-center text-xs text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => {
                            setMode(mode === "totp" ? "backup" : "totp");
                            setError(null);
                        }}
                    >
                        {mode === "totp" ? "Use a backup code instead" : "Use your authenticator instead"}
                    </button>
                </CardBody>
            </Card>
        </main>
    );
}
