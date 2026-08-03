"use client";

/**
 * Why you are not where you clicked.
 *
 * Being turned away from a screen used to be silent: the redirect carried a
 * `denied` flag that nothing read, so the page simply changed under you. That was
 * survivable while everybody could open Drive; it is not now that a role can open
 * nothing at all and land here for every link it is sent.
 *
 * The flag is dropped from the address once it has been said, so a refresh or a
 * shared link does not repeat an answer to a question nobody asked again.
 */

import { X } from "lucide-react";
import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

function Notice() {
    const router = useRouter();
    const pathname = usePathname();
    const params = useSearchParams();
    const [dismissed, setDismissed] = useState(false);

    if (dismissed || params.get("denied") !== "1") return null;

    function dismiss() {
        setDismissed(true);
        const rest = new URLSearchParams(params);
        rest.delete("denied");
        const query = rest.toString();
        router.replace(query ? `${pathname}?${query}` : pathname);
    }

    return (
        <div
            role="status"
            className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3"
        >
            <p className="min-w-0 text-sm">
                That page is not open to your role. This is where your access starts.
            </p>
            <button
                type="button"
                aria-label="Dismiss"
                title="Dismiss"
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                onClick={dismiss}
            >
                <X className="size-4" />
            </button>
        </div>
    );
}

export function DeniedNotice() {
    // useSearchParams suspends on a statically rendered route; the boundary keeps
    // that a local concern rather than the whole shell's.
    return (
        <Suspense fallback={null}>
            <Notice />
        </Suspense>
    );
}
