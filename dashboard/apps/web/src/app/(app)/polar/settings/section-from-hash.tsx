"use client";

/** Links from before each section had its own address arrive with a hash. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function SectionFromHash({ ids }: { ids: readonly string[] }) {
    const router = useRouter();
    useEffect(() => {
        const section = window.location.hash.slice(1);
        if (!ids.includes(section)) return;
        const url = new URL(window.location.href);
        url.searchParams.set("section", section);
        router.replace(`${url.pathname}${url.search}`);
    }, [ids, router]);
    return null;
}
