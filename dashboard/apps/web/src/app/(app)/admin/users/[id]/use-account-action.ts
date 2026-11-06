"use client";

/**
 * Run one change to an account, keep its refusal on screen, and re-read the page.
 *
 * Shared by every section of the record so each control saves on its own and
 * reports the same way.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function useAccountAction() {
    const router = useRouter();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run(
        action: () => Promise<{ error?: string }>,
        after?: () => Promise<void>
    ): Promise<boolean> {
        setBusy(true);
        setError(null);
        const result = await action();
        setBusy(false);
        if (result.error) {
            setError(result.error);
            return false;
        }
        await after?.();
        router.refresh();
        return true;
    }

    return { busy, error, run, setError };
}
