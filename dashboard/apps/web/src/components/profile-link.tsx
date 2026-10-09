"use client";

/**
 * A link to somebody's page, or an organization's, that still arrives there for
 * a reader with no way into the application.
 *
 * Followed from inside Polaris, `/u/<username>` and `/o/<slug>` are drawn in the
 * application's own layout (see `(app)/(.)u/[username]`) so the call a tab is in
 * survives the click. Next.js decides that from the address the click starts
 * at, and a route group is not part of an address, so the same thing happens
 * from the public pages - where a reader who is signed out, or whose gate has
 * not cleared, is turned away by that layout and lands on the sign-in screen
 * instead of the page they followed. Under `OutsideApp` the link is a plain
 * anchor: a whole page load, which is never intercepted and needs no session.
 */

import Link from "next/link";
import { createContext, useContext, type ComponentPropsWithoutRef, type ReactNode } from "react";

const Outside = createContext(false);

/** Marks what it holds as drawn for a reader who cannot enter the application. */
export function OutsideApp({ children }: { children: ReactNode }) {
    return <Outside.Provider value>{children}</Outside.Provider>;
}

export function ProfileLink(props: ComponentPropsWithoutRef<"a"> & { href: string }) {
    return useContext(Outside) ? <a {...props} /> : <Link {...props} />;
}
