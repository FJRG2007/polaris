/**
 * Polar in use, in a browser: asked for release notes on its own page in the
 * dashboard (`polar`), and in the browser extension's side panel beside a
 * shop's product page (`polar-side-panel`), asked about that page, answering
 * it, and then working the page itself - a size picked, the basket filled.
 *
 * Both chats are `PolarChat` itself. The side panel draws it the way the
 * extension's frame does (`(embed)/polar/embed/polar-embed.tsx`): full page,
 * with the page in front of the person as its site. The shop is invented and
 * drawn here only as the page the panel sits beside.
 */

import { Star } from "lucide-react";
import { Chrome } from "../runtime/chrome";
import { useEffect, useState } from "react";
import { BrowserFrame, PHONE_WIDTH, PolarisTabIcon, framedScene } from "../runtime/browser-frame";
import { PAGE_BLEED, cn } from "@polaris/ui";
import { THREAD_KEY } from "@/lib/polar/stored";
import { PolarChat } from "@/components/polar/polar-panel";
import { defineScene, type SceneContext } from "../runtime/scene";
import {
    OPEN_THREAD_ID,
    POLAR_PROVIDERS,
    SHOP,
    SHOP_SIZES,
    polarThread,
    polarThreads,
    type PolarStage
} from "../fixtures/polar";

/** The dashboard page's steps: how far the chat has got, how long it holds. */
const PAGE_PLAY: { stage: PolarStage; hold: number }[] = [
    { stage: "asked", hold: 1300 },
    { stage: "answering", hold: 1200 },
    { stage: "answered", hold: 2600 }
];

/** The side panel's steps: the page asked about, then worked. */
const PANEL_PLAY: { stage: PolarStage; hold: number }[] = [
    { stage: "asked", hold: 1500 },
    { stage: "answering", hold: 1100 },
    { stage: "answered", hold: 2600 },
    { stage: "acting", hold: 1600 },
    { stage: "acted", hold: 3200 }
];

/**
 * The side panel is a page of its own, the way the extension opens it: this
 * scene again in a frame 420 px wide, told which stage to draw. At that width
 * the chat lays itself out as it does in the real panel - its chat list put
 * away behind a button - which a 420 px box inside a wide page would not do.
 */
const PANEL = new URLSearchParams(window.location.search).get("panel") as PolarStage | null;

/** The step on screen; the still shows the answered chat. */
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
function ShopPage({ ctx, stage }: { ctx: SceneContext; stage: PolarStage }) {
    const lang = ctx.locale === "es-ES" ? "es" : "en";
    const phone = window.innerWidth < PHONE_WIDTH;
    // What Polar has done to the page so far: the size it picked, the button
    // it is pressing, and the basket once it has.
    const picked = stage === "acting" || stage === "acted" ? 1 : 0;
    const pressing = stage === "acting";
    const basket = stage === "acted" ? 1 : 0;
    return (
        <div
            style={{
                flex: "1 1 0",
                minWidth: 0,
                overflow: "hidden",
                background: "#fff",
                color: INK
            }}
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
                    style={{
                        flex: 1,
                        height: 30,
                        borderRadius: 6,
                        border: `1px solid ${LINE}`,
                        background: "#f5f7f9"
                    }}
                />
                <span style={{ fontSize: 13, color: MUTED }}>
                    {ctx.say(`Basket (${basket})`, `Cesta (${basket})`)}
                </span>
            </div>
            <div
                style={{
                    display: "flex",
                    flexDirection: phone ? "column" : "row",
                    gap: phone ? 16 : 28,
                    padding: phone ? 16 : 28
                }}
            >
                <div
                    style={{
                        flex: phone ? "none" : "0 0 38%",
                        maxHeight: phone ? 160 : undefined,
                        aspectRatio: "1",
                        borderRadius: 12,
                        display: "grid",
                        placeItems: "center",
                        background: "linear-gradient(135deg, #ccfbf1, #e0f2fe)"
                    }}
                >
                    <div
                        style={{
                            width: "42%",
                            height: "62%",
                            borderRadius: 40,
                            background: BRAND,
                            boxShadow: "0 18px 40px rgba(15,118,110,.35)"
                        }}
                    />
                </div>
                <div
                    style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        flexDirection: "column",
                        gap: 10
                    }}
                >
                    <h1 style={{ fontSize: 24, fontWeight: 600, lineHeight: 1.2 }}>
                        {SHOP.product[lang]}
                    </h1>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
                        <span style={{ display: "flex", color: STARS }}>
                            {[0, 1, 2, 3, 4].map((n) => (
                                <Star key={n} size={15} fill={n < 4 ? "currentColor" : "none"} />
                            ))}
                        </span>
                        <span style={{ color: MUTED }}>
                            {lang === "es" ? "4,4" : SHOP.rating} ·{" "}
                            {ctx.say("1,286 reviews", "1286 opiniones")}
                        </span>
                    </div>
                    <p style={{ fontSize: 28, fontWeight: 700 }}>{SHOP.price}</p>
                    <ul style={{ paddingLeft: 18, listStyle: "disc", fontSize: 13, color: MUTED }}>
                        {SHOP.points[lang].map((point) => (
                            <li key={point}>{point}</li>
                        ))}
                    </ul>
                    <div style={{ display: "flex", gap: 8 }}>
                        {SHOP_SIZES.map((size, index) => (
                            <span
                                key={size}
                                style={{
                                    borderRadius: 8,
                                    padding: "5px 12px",
                                    fontSize: 13,
                                    border: `1px solid ${index === picked ? BRAND : LINE}`,
                                    color: index === picked ? BRAND : INK,
                                    fontWeight: index === picked ? 600 : 400
                                }}
                            >
                                {size}
                            </span>
                        ))}
                    </div>
                    <span
                        style={{
                            width: "fit-content",
                            borderRadius: 999,
                            boxShadow: pressing ? `0 0 0 3px ${BRAND}55` : "none",
                            background: BRAND,
                            color: "#fff",
                            padding: "8px 22px",
                            fontSize: 13,
                            fontWeight: 600
                        }}
                    >
                        {ctx.say("Add to basket", "Añadir a la cesta")}
                    </span>
                    <h2 style={{ marginTop: 10, fontSize: 15, fontWeight: 600 }}>
                        {ctx.say("Reviews", "Opiniones")}
                    </h2>
                    {SHOP.quotes[lang].map(([text, stars]) => (
                        <div
                            key={text}
                            style={{
                                border: `1px solid ${LINE}`,
                                borderRadius: 8,
                                padding: 10,
                                fontSize: 13
                            }}
                        >
                            <span style={{ color: STARS }}>
                                {"★".repeat(stars)}
                                {"☆".repeat(5 - stars)}
                            </span>
                            <p style={{ color: MUTED }}>{text}</p>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

/** What the extension's side panel draws: the chat, with the page in front of the reader as its site. */
function SidePanel() {
    return (
        <div className="flex h-dvh bg-card">
            <PolarChat fullPage site={{ url: SHOP.url, title: SHOP.store }} />
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

/** The shop in a browser, with the extension's side panel open beside it. */
function ShopWithPanel({ ctx }: { ctx: SceneContext }) {
    const stage = PANEL_PLAY[useStep()]!.stage;
    const lang = ctx.locale === "es-ES" ? "es" : "en";
    const phone = window.innerWidth < PHONE_WIDTH;
    // The extension's side panel, at the width a browser opens it; on a phone,
    // as a sheet over the page.
    const panel = (
        <iframe
            key={stage}
            id="polar-side-panel"
            title="Polar"
            src={`${window.location.pathname}${window.location.search}&panel=${stage}`}
            className="border-border bg-card"
            style={
                phone
                    ? {
                          position: "absolute",
                          left: 0,
                          right: 0,
                          bottom: 0,
                          width: "100%",
                          height: "64%",
                          borderTopWidth: 1,
                          borderRadius: "14px 14px 0 0",
                          boxShadow: "0 -12px 32px rgba(0,0,0,.25)"
                      }
                    : { width: 420, flex: "none", height: "100%", borderLeftWidth: 1 }
            }
        />
    );
    return (
        <BrowserFrame
            ctx={ctx}
            tabs={[
                { title: `${SHOP.product[lang]} - ${SHOP.store}`, color: BRAND },
                { title: "Polaris", icon: <PolarisTabIcon /> }
            ]}
            url={SHOP.url}
            extensionLit
        >
            <ShopPage ctx={ctx} stage={stage} />
            {panel}
        </BrowserFrame>
    );
}

/** The page `/polar` draws, the way the dashboard draws it. */
function PolarPage() {
    const step = PAGE_PLAY[useStep()]!;
    return (
        <Chrome>
            <div className={cn(PAGE_BLEED, "flex bg-card")}>
                <PolarChat key={`page-${step.stage}`} fullPage />
            </div>
        </Chrome>
    );
}

/** What every Polar screen asks the server, with the chat where `now` says. */
function polarApi(ctx: SceneContext, now: () => { stage: PolarStage; shop: boolean }) {
    return {
        "GET /api/polar/models": () => ({
            providers: POLAR_PROVIDERS,
            isAdmin: true,
            spendsDeployment: true
        }),
        "GET /api/polar/threads": () => ({ threads: polarThreads(ctx), pinned: [], projects: [] }),
        "GET /api/polar/threads/:id": () => {
            const at = now();
            return { thread: polarThread(ctx, at.stage, at.shop) };
        },
        "GET /api/polar/feedback": () => ({ marks: {} }),
        "GET /api/polar/preferences": () => ({}),
        "GET /api/polar/commands": () => ({ commands: [] }),
        "GET /api/polar/shared": () => ({ shared: [] }),
        "GET /api/polar/runs": () => ({}),
        "GET /api/polar/code": () => ({ access: "none", sessions: [], next: null }),
        // Nothing is being answered in the background, which the route says with 204.
        "GET /api/polar/chat/:id/stream": () => new Response(null, { status: 204 })
    };
}

/** The chat that was open before, which is the one the page reopens. */
function openThread() {
    window.localStorage.setItem(THREAD_KEY, OPEN_THREAD_ID);
}

/** The dashboard's Polar page, drawn only inside the browser of `polar`. */
export const polarPage = defineScene({
    id: "polar-page",
    path: "/polar",
    api: (ctx) => polarApi(ctx, () => ({ stage: PAGE_PLAY[current]!.stage, shop: false })),
    render: () => {
        openThread();
        return <PolarPage />;
    },
    animation: {
        frames: PAGE_PLAY.length,
        step: (index) => {
            current = index;
            for (const listener of listeners) listener(index);
        },
        hold: (index) => PAGE_PLAY[index]!.hold,
        advance: () => 900
    }
});

export const polar = framedScene("polar", polarPage, (ctx) => ({
    tabs: [
        { title: "Polar - Polaris", icon: <PolarisTabIcon /> },
        { title: ctx.say("Inbox - Polaris", "Bandeja - Polaris"), icon: <PolarisTabIcon /> }
    ],
    url: "https://polaris.example.com/polar"
}));

export const polarSidePanel = defineScene({
    id: "polar-side-panel",
    path: "/polar",
    api: (ctx) =>
        polarApi(ctx, () => ({ stage: PANEL ?? PANEL_PLAY[current]!.stage, shop: true })),
    render: (ctx) => {
        openThread();
        return PANEL ? <SidePanel /> : <ShopWithPanel ctx={ctx} />;
    },
    animation: {
        frames: PANEL_PLAY.length,
        step: async (index) => {
            current = index;
            for (const listener of listeners) listener(index);
            await panelDrawn();
        },
        hold: (index) => PANEL_PLAY[index]!.hold,
        advance: () => 900
    }
});
