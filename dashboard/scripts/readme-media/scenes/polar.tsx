/**
 * Polar in use: asked for release notes on its own page in the dashboard, then
 * in the browser extension's side panel beside a shop's product page, asked
 * about that page and answering it.
 *
 * Both chats are `PolarChat` itself. The side panel draws it the way the
 * extension's frame does (`(embed)/polar/embed/polar-embed.tsx`): full page,
 * with the page in front of the person as its site. The shop is invented and
 * drawn here only as the page the panel sits beside.
 */

import { Star } from "lucide-react";
import { Chrome } from "../runtime/chrome";
import { useEffect, useState } from "react";
import { PAGE_BLEED, cn } from "@polaris/ui";
import { THREAD_KEY } from "@/lib/polar/stored";
import { PolarChat } from "@/components/polar/polar-panel";
import { defineScene, type SceneContext } from "../runtime/scene";
import {
    OPEN_THREAD_ID,
    POLAR_PROVIDERS,
    SHOP,
    polarThread,
    polarThreads,
    type PolarStage
} from "../fixtures/polar";

/** The animation's steps: where the picture is, how far the chat has got, how long it holds. */
const PLAY: { shop: boolean; stage: PolarStage; hold: number }[] = [
    { shop: false, stage: "asked", hold: 1300 },
    { shop: false, stage: "answering", hold: 1200 },
    { shop: false, stage: "answered", hold: 2600 },
    { shop: true, stage: "asked", hold: 1600 },
    { shop: true, stage: "answering", hold: 1200 },
    { shop: true, stage: "answered", hold: 3400 }
];

/**
 * The side panel is a page of its own, the way the extension opens it: this
 * scene again in a frame 420 px wide, told which stage to draw. At that width
 * the chat lays itself out as it does in the real panel - its chat list put
 * away behind a button - which a 420 px box inside a wide page would not do.
 */
const PANEL = new URLSearchParams(window.location.search).get("panel") as PolarStage | null;

/** The phone plays only the dashboard: the side panel is a desktop browser's. */
const SHOWN = () => (window.innerWidth < 768 ? PLAY.filter((one) => !one.shop) : PLAY);

/** The step on screen; the still shows the finished dashboard chat. */
let current = 2;
const listeners = new Set<(step: number) => void>();

function useStep(): number {
    const [step, setStep] = useState(current);
    useEffect(() => {
        listeners.add(setStep);
        return () => {
            listeners.delete(setStep);
        };
    }, []);
    return step;
}

/** The shop's colours, inline: an invented store, not part of Polaris's design. */
const INK = "#1f2933";
const MUTED = "#52606d";
const LINE = "#d9dee3";
const BRAND = "#0f766e";
const STARS = "#d97706";

/** The product page: an invented shop, plainly so. */
function ShopPage({ ctx }: { ctx: SceneContext }) {
    const lang = ctx.locale === "es-ES" ? "es" : "en";
    return (
        <div
            style={{ flex: "1 1 0", minWidth: 0, overflow: "hidden", background: "#fff", color: INK }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "12px 24px",
                    borderBottom: `1px solid ${LINE}`
                }}
            >
                <b style={{ fontSize: 18, color: BRAND }}>{SHOP.store}</b>
                <div
                    style={{ flex: 1, height: 30, borderRadius: 6, border: `1px solid ${LINE}`, background: "#f5f7f9" }}
                />
                <span style={{ fontSize: 13, color: MUTED }}>{ctx.say("Basket (0)", "Cesta (0)")}</span>
            </div>
            <div style={{ display: "flex", gap: 28, padding: 28 }}>
                <div
                    style={{
                        flex: "0 0 38%",
                        aspectRatio: "1",
                        borderRadius: 12,
                        display: "grid",
                        placeItems: "center",
                        background: "linear-gradient(135deg, #ccfbf1, #e0f2fe)"
                    }}
                >
                    <div style={{ width: "42%", height: "62%", borderRadius: 40, background: BRAND, boxShadow: "0 18px 40px rgba(15,118,110,.35)" }} />
                </div>
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                    <h1 style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}>{SHOP.product[lang]}</h1>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <span style={{ display: "flex", color: STARS }}>
                            {[0, 1, 2, 3, 4].map((n) => (
                                <Star key={n} size={15} fill={n < 4 ? "currentColor" : "none"} />
                            ))}
                        </span>
                        <span style={{ color: MUTED }}>
                            {lang === "es" ? "4,4" : SHOP.rating} · {ctx.say("1,286 reviews", "1286 opiniones")}
                        </span>
                    </div>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>{SHOP.price}</p>
                    <ul style={{ paddingLeft: 18, listStyle: "disc", fontSize: 13, color: MUTED }}>
                        {SHOP.points[lang].map((point) => (
                            <li key={point}>{point}</li>
                        ))}
                    </ul>
                    <span
                        style={{ width: "fit-content", borderRadius: 999, background: BRAND, color: "#fff", padding: "8px 22px", fontSize: 13, fontWeight: 600 }}
                    >
                        {ctx.say("Add to basket", "Añadir a la cesta")}
                    </span>
                    <h2 style={{ marginTop: 10, fontSize: 15, fontWeight: 600 }}>{ctx.say("Reviews", "Opiniones")}</h2>
                    {SHOP.quotes[lang].map(([text, stars]) => (
                        <div key={text} style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: 10, fontSize: 13 }}>
                            <span style={{ color: STARS }}>{"★".repeat(stars)}{"☆".repeat(5 - stars)}</span>
                            <p style={{ color: MUTED }}>{text}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** A browser window: its address bar, the shop, and the extension's side panel. */
function Browser({ ctx, stage }: { ctx: SceneContext; stage: PolarStage }) {
    const lang = ctx.locale === "es-ES" ? "es" : "en";
    const dark = ctx.theme === "dark";
    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100dvh", background: dark ? "#2b2d31" : "#e3e5e8" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px" }}>
                <span style={{ display: "flex", gap: 6 }}>
                    {["#f87171", "#fbbf24", "#4ade80"].map((color) => (
                        <i key={color} style={{ width: 11, height: 11, borderRadius: 99, background: color }} />
                    ))}
                </span>
                <div
                    style={{
                        flex: 1,
                        borderRadius: 999,
                        padding: "5px 14px",
                        fontSize: 13,
                        background: dark ? "#1e1f22" : "#fff",
                        color: dark ? "#dbdee1" : MUTED
                    }}
                >
                    {SHOP.url.replace("https://", "")}
                </div>
            </div>
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                <ShopPage ctx={ctx} />
                {/* The extension's side panel, at the width a browser opens it. */}
                <iframe
                    key={stage}
                    id="polar-side-panel"
                    title="Polar"
                    src={`${window.location.pathname}${window.location.search}&panel=${stage}`}
                    className="border-l border-border bg-card"
                    style={{ width: 420, flex: "none", height: "100%" }}
                />
            </div>
        </div>
    );
}

/** What the extension's side panel draws: the chat, with the page in front of the reader as its site. */
function SidePanel({ ctx }: { ctx: SceneContext }) {
    const lang = ctx.locale === "es-ES" ? "es" : "en";
    return (
        <div className="flex h-dvh bg-card">
            <PolarChat fullPage site={{ url: SHOP.url, title: `${SHOP.product[lang]} - ${SHOP.store}` }} />
        </div>
    );
}

/** Resolves once the side panel's page has drawn its answer. */
async function panelDrawn(): Promise<void> {
    for (;;) {
        const frame = document.getElementById("polar-side-panel") as HTMLIFrameElement | null;
        const inner = frame?.contentWindow as (Window & { __scene?: { ready: boolean } }) | null;
        if (inner?.__scene?.ready && inner.document.querySelector("textarea")) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function PolarInUse({ ctx }: { ctx: SceneContext }) {
    const step = SHOWN()[useStep()]!;
    if (step.shop) return <Browser ctx={ctx} stage={step.stage} />;
    return (
        <Chrome>
            {/* The page `/polar` draws. */}
            <div className={cn(PAGE_BLEED, "flex bg-card")}>
                <PolarChat key={`page-${step.stage}`} fullPage />
            </div>
        </Chrome>
    );
}

export const polar = defineScene({
    id: "polar",
    path: "/polar",
    api: (ctx) => ({
        "GET /api/polar/models": () => ({
            providers: POLAR_PROVIDERS,
            isAdmin: true,
            spendsDeployment: true
        }),
        "GET /api/polar/threads": () => ({ threads: polarThreads(ctx), pinned: [], projects: [] }),
        "GET /api/polar/threads/:id": () => {
            const step = PANEL ? { stage: PANEL, shop: true } : SHOWN()[current]!;
            return { thread: polarThread(ctx, step.stage, step.shop) };
        },
        "GET /api/polar/feedback": () => ({ marks: {} }),
        "GET /api/polar/preferences": () => ({}),
        "GET /api/polar/commands": () => ({ commands: [] }),
        "GET /api/polar/shared": () => ({ shared: [] }),
        "GET /api/polar/runs": () => ({}),
        "GET /api/polar/code": () => ({ access: "none", sessions: [], next: null }),
        // Nothing is being answered in the background, which the route says with 204.
        "GET /api/polar/chat/:id/stream": () => new Response(null, { status: 204 })
    }),
    render: (ctx) => {
        // The chat that was open before, which is the one the page reopens.
        window.localStorage.setItem(THREAD_KEY, OPEN_THREAD_ID);
        return PANEL ? <SidePanel ctx={ctx} /> : <PolarInUse ctx={ctx} />;
    },
    animation: {
        get frames() {
            return SHOWN().length;
        },
        step: async (index) => {
            current = index;
            for (const listener of listeners) listener(index);
            if (SHOWN()[index]!.shop) await panelDrawn();
        },
        hold: (index) => SHOWN()[index]!.hold,
        advance: () => 900
    }
});
