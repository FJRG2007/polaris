"use client";

/**
 * Sends an old `/admin/domains#section` link on to the page that holds that
 * section now. Draws nothing.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { movedAnchorHref } from "./moved-anchors";

export function MovedAnchorRedirect() {
    const router = useRouter();

    useEffect(() => {
        function follow() {
            const href = movedAnchorHref(window.location.hash);
            if (href) router.replace(href);
        }
        follow();
        window.addEventListener("hashchange", follow);
        return () => window.removeEventListener("hashchange", follow);
    }, [router]);

    return null;
}
