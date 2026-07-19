"use client";

/**
 * PIN gate for a protected drop point. Submits to the unlock action, which sets
 * the httpOnly unlock cookie on success. A localStorage throttle imposes a short
 * local cooldown after repeated failures - instant feedback that also spares the
 * server; the server enforces the real rate limit. Errors are generic so the
 * form cannot be used to probe which links exist.
 */

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { unlockFileRequestAction } from "@/app/(app)/drive/request-actions";
import { clearAttempts, cooldownRemaining, recordFailure } from "@/lib/attempt-throttle";

export function RequestPasswordForm({ token, title }: { token: string; title: string }) {
    const router = useRouter();
    const [pin, setPin] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        const wait = cooldownRemaining(token);
        if (wait > 0) {
            setError(`Too many attempts. Try again in ${wait}s.`);
            return;
        }
        startTransition(async () => {
            const result = await unlockFileRequestAction(token, pin);
            if (result.error) {
                recordFailure(token);
                setError(result.error);
                return;
            }
            clearAttempts(token);
            router.refresh();
        });
    }

    return (
        <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <PolarisMark className="size-6" />
                <span className="text-sm font-medium">Polaris</span>
            </div>
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <Lock className="size-4" />
                        {title}
                    </CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">Enter the PIN to upload to this drop point.</p>
                        <Input
                            type="password"
                            autoFocus
                            required
                            value={pin}
                            onChange={(event) => setPin(event.target.value)}
                            placeholder="PIN"
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || !pin}>
                            {pending ? "Checking..." : "Continue"}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}
