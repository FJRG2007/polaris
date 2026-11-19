"use client";

/**
 * The app commands this person may run, for the composer's "/" list.
 *
 * Asked once per tab and kept: the list changes only when an administrator
 * changes who may use an app, and a command offered a moment too long is
 * still checked when it runs. An empty list until it arrives - the composer
 * draws now and the commands join it.
 */

import * as actions from "./actions";
import { useEffect, useState } from "react";
import type { AppCommandView } from "@/lib/chat/app-commands";

let asked: Promise<AppCommandView[]> | null = null;

export function useAppCommands(): readonly AppCommandView[] {
    const [commands, setCommands] = useState<readonly AppCommandView[]>([]);
    useEffect(() => {
        let live = true;
        // Asked again next time when it fails: a list that failed is not an
        // empty one. Caught whichever way it fails, thrown or rejected: the
        // composer must draw either way.
        const forget = (): AppCommandView[] => {
            asked = null;
            return [];
        };
        try {
            asked ??= actions.appCommandsAction().catch(forget);
        } catch {
            forget();
            return;
        }
        void asked.then((found) => live && setCommands(found));
        return () => {
            live = false;
        };
    }, []);
    return commands;
}
