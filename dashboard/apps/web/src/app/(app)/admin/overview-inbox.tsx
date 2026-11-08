"use client";

import type { ReactNode } from "react";
import { paintRead } from "./paint-read";
import { AfterPaint } from "@/components/after-paint";

/**
 * The overview's inbox card, shown once the read says the messaging bridge is
 * installed. Every other card is drawn with the page; this one only appears.
 */
export function InboxCardWhenInstalled({ children }: { children: ReactNode }) {
    return (
        <AfterPaint cacheKey="admin.overview" load={() => paintRead("overview")} skeleton={null}>
            {(data) => (data.inbox ? children : null)}
        </AfterPaint>
    );
}
