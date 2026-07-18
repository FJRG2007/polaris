"use client";

/**
 * Password gate for a protected share. Submits to the unlock action, which sets
 * the httpOnly unlock cookie on success and lets the page re-render into its
 * contents. Errors are deliberately generic so the form cannot be used to probe
 * which links exist or whether a guess was close.
 */

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, PolarisMark } from "@polaris/ui";
import { unlockShareAction } from "@/app/(app)/drive/share-actions";

export function SharePasswordForm({ token }: { token: string }) {
    const router = useRouter();
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function onSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
            const result = await unlockShareAction(token, password);
            if (result.error) {
                setError(result.error);
                return;
            }
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
                        Password required
                    </CardTitle>
                </CardHeader>
                <CardBody>
                    <form onSubmit={onSubmit} className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            This link is protected. Enter its password to continue.
                        </p>
                        <Input
                            type="password"
                            autoFocus
                            required
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder="Password"
                        />
                        {error ? <p className="text-sm text-danger">{error}</p> : null}
                        <Button type="submit" disabled={pending || !password}>
                            {pending ? "Checking..." : "Unlock"}
                        </Button>
                    </form>
                </CardBody>
            </Card>
        </div>
    );
}
