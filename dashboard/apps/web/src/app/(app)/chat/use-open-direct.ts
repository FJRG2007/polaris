"use client";

/**
 * Open the conversation with somebody, from wherever their name was pressed.
 *
 * Three places ask for it - the roster, the menu a right-click opens, and a name
 * in the messages themselves - and they all mean the same thing: find the
 * one-to-one conversation with this person, making it if there is not one yet,
 * and go there. It was written twice before the third arrived, which is the
 * point at which a third copy starts drifting from the other two.
 *
 * The busy flag covers the whole surface rather than the one name that was
 * pressed. Opening takes a round trip, and a second press during it is either
 * the same conversation asked for twice or a different one that will land on top
 * of the first - both worse than a name that cannot be pressed for a moment.
 */

import * as actions from "./actions";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { runAction } from "@/lib/run-action";

export function useOpenDirect(
    /** Told what went wrong, and told an empty string as each attempt starts so
     *  a surface that shows the last failure can clear it. */
    onError: (message: string) => void
) {
    const router = useRouter();
    const [busy, setBusy] = useState(false);

    /**
     * Go to the conversation with them.
     *
     * `then` is for a caller that wants somewhere else than the conversation
     * itself - a call, which is the same address with the answer on it.
     */
    const open = async (userId: string, then?: (channelId: string) => void) => {
        setBusy(true);
        onError("");
        const result = await runAction(() => actions.openDirectAction({ userIds: [userId] }), onError);
        setBusy(false);
        if (!result?.id) return;
        if (then) then(result.id);
        else router.push(`/chat/c/${result.id}`);
    };

    return { busy, open };
}
