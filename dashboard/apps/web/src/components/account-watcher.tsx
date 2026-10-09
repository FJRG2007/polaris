"use client";

/**
 * Keeps every tab on the account the browser is actually acting as. See
 * `lib/account-switch` for why a change of account means a fresh load.
 */

import { useEffect, useState } from "react";
import { listenForAccountChange, reconcileAccount } from "@/lib/account-switch";

export function AccountWatcher({ userId }: { userId: string }) {
    // During the first render rather than in an effect: the screens below read
    // what this tab kept in their own effects, which run before this one's would.
    useState(() => {
        if (typeof window !== "undefined") reconcileAccount(userId);
        return null;
    });
    useEffect(() => listenForAccountChange(userId), [userId]);
    return null;
}
