/** Polar: the assistant on its own page, a chat open beside the others. */

import { Chrome } from "../runtime/chrome";
import { PAGE_BLEED, cn } from "@polaris/ui";
import { defineScene } from "../runtime/scene";
import { THREAD_KEY } from "@/lib/polar/stored";
import { PolarChat } from "@/components/polar/polar-panel";
import { OPEN_THREAD_ID, POLAR_PROVIDERS, polarThread, polarThreads } from "../fixtures/polar";

export const polar = defineScene({
    id: "polar",
    path: "/polar",
    api: (ctx) => ({
        "GET /api/polar/models": () => ({ providers: POLAR_PROVIDERS, isAdmin: true, spendsDeployment: true }),
        "GET /api/polar/threads": () => ({ threads: polarThreads(ctx), pinned: [], projects: [] }),
        "GET /api/polar/threads/:id": () => ({ thread: polarThread(ctx) }),
        "GET /api/polar/feedback": () => ({ marks: {} }),
        "GET /api/polar/preferences": () => ({}),
        "GET /api/polar/commands": () => ({ commands: [] }),
        "GET /api/polar/shared": () => ({ shared: [] }),
        "GET /api/polar/runs": () => ({}),
        "GET /api/polar/code": () => ({ access: "none", sessions: [], next: null }),
        // Nothing is being answered in the background, which the route says with 204.
        "GET /api/polar/chat/:id/stream": () => new Response(null, { status: 204 })
    }),
    render: () => {
        // The chat that was open before, which is the one the page reopens.
        window.localStorage.setItem(THREAD_KEY, OPEN_THREAD_ID);
        return (
            <Chrome>
                {/* The page `/polar` draws. */}
                <div className={cn(PAGE_BLEED, "flex bg-card")}>
                    <PolarChat fullPage />
                </div>
            </Chrome>
        );
    }
});
