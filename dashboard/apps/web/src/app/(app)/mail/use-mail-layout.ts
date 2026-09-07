"use client";

/**
 * Which shape the reader has Mail in.
 *
 * `split` keeps a narrow list beside the conversation, which is what somebody
 * triaging a hundred messages wants. `full` gives the list the whole width and
 * hands the whole width to the message once one is open, which is what somebody
 * who reads one message at a time wants. Neither is right for both people, and
 * neither is right for the same person all the time.
 *
 * `full` is the default because it is what a mail client looks like to almost
 * everybody: a list, and the message you clicked. The reading pane beside it is
 * the deliberate choice, not the thing somebody has to discover they can turn
 * off.
 *
 * Kept in the browser rather than on the account, because it is a preference
 * about this screen on this device - the same reason a collapsed section is. It
 * is read once on mount rather than during render: a value that differs between
 * the server's HTML and the browser's first paint is a hydration mismatch, so
 * the default is what gets painted while the answer is read.
 */

import { useCallback, useEffect, useState } from "react";

export type MailLayout = "split" | "full";

const KEY = "polaris.mail.layout";

export function useMailLayout(): [MailLayout, (next: MailLayout) => void] {
    const [layout, setLayout] = useState<MailLayout>("full");

    useEffect(() => {
        try {
            const held = window.localStorage.getItem(KEY);
            if (held === "split" || held === "full") setLayout(held);
        } catch {
            // A browser told to keep no site data. The default stands, which is
            // a working screen rather than a broken one.
        }
    }, []);

    const choose = useCallback((next: MailLayout) => {
        setLayout(next);
        try {
            window.localStorage.setItem(KEY, next);
        } catch {
            // It still applies for this visit; it just will not be remembered.
        }
    }, []);

    return [layout, choose];
}
