"use client";

/**
 * An installed app whose code this server does not have yet: why, and the
 * button that tries again. Shown in place of the app's screen.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PackageX, RotateCw } from "lucide-react";
import { Button, EmptyState } from "@polaris/ui";
import { retryAppAction } from "@/lib/app-bundles/actions";

export function AppUnavailable({ app, name, reason }: { app: string; name: string; reason: string }) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, start] = useTransition();

    const retry = () =>
        start(async () => {
            const result = await retryAppAction(app);
            if (result.error) setError(result.error);
            else router.refresh();
        });

    return (
        <EmptyState
            icon={<PackageX />}
            title={`${name} is not available right now`}
            description={error ?? reason}
            action={
                <Button onClick={retry} disabled={pending}>
                    <RotateCw className={pending ? "animate-spin" : undefined} />
                    Try again
                </Button>
            }
        />
    );
}
