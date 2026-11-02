"use client";

/** Links from before each section had its own address arrive with a hash. */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { settingsSection } from "@/lib/polar/settings-path";

export function SectionFromHash({ ids }: { ids: readonly string[] }) {
    const router = useRouter();
    useEffect(() => {
        const section = window.location.hash.slice(1);
        if (ids.includes(section)) router.replace(settingsSection(section));
    }, [ids, router]);
    return null;
}
