"use client";

/**
 * The reminder that you are not looking at your own Polaris. It floats above the
 * page on every screen, deliberately: an administrator acting as somebody else
 * writes to that person's account for real, and the one failure this feature
 * cannot afford is forgetting it is on.
 *
 * The way out lives here rather than on an operator screen, because viewing an
 * account with no operator screens is exactly when you need it.
 */

import { useState } from "react";
import { Button } from "@polaris/ui";
import { Eye, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { stopViewAsAction } from "@/app/(app)/view-as-actions";

export function ViewAsBanner({ mode, label, actorName }: { mode: "user" | "role"; label: string; actorName: string }) {
    const router = useRouter();
    const [leaving, setLeaving] = useState(false);

    async function leave() {
        setLeaving(true);
        await stopViewAsAction();
        // Back to the root, which resolves where the administrator's own access
        // starts - the screen they were on may not be one of them.
        router.push("/");
        router.refresh();
    }

    return (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-3">
            <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-full border border-warning/40 bg-warning/15 py-1.5 pl-4 pr-1.5 shadow-lg backdrop-blur">
                <Eye className="size-4 shrink-0 text-warning" aria-hidden="true" />
                <p className="min-w-0 truncate text-sm">
                    {mode === "user" ? (
                        <>
                            Using Polaris as <span className="font-medium">{label}</span>
                        </>
                    ) : (
                        <>
                            Seeing Polaris as the <span className="font-medium">{label}</span> role
                        </>
                    )}
                    <span className="hidden text-muted-foreground sm:inline"> - you are {actorName}</span>
                </p>
                <Button size="sm" variant="ghost" className="rounded-full" disabled={leaving} onClick={() => void leave()}>
                    <LogOut className="size-4" />
                    {leaving ? "Leaving..." : "Back to my account"}
                </Button>
            </div>
        </div>
    );
}
