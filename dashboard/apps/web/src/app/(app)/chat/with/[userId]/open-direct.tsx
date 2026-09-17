"use client";

import { useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { openDirectAction } from "../../actions";
import { EmptyState, Skeleton } from "@polaris/ui";

export function OpenDirect({ userId }: { userId: string }) {
    const router = useRouter();
    const [error, setError] = useState("");

    useEffect(() => {
        let live = true;
        void openDirectAction({ userIds: [userId] })
            .then((result) => {
                if (!live) return;
                // Replaced rather than pushed, so Back does not land here and open
                // it a second time.
                if (result.id) router.replace(`/chat/c/${result.id}`);
                else setError(result.error ?? "That conversation could not be opened.");
            })
            .catch(() => live && setError("That conversation could not be opened. Try again."));
        return () => {
            live = false;
        };
    }, [router, userId]);

    if (error) {
        return (
            <div className="flex flex-1 items-center justify-center p-6">
                <EmptyState icon={<MessageCircle />} title="No conversation to open." description={error} />
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col">
            <div className="flex h-header shrink-0 items-center gap-2 border-b border-border px-4">
                <Skeleton className="h-4 w-40" />
            </div>
        </div>
    );
}
