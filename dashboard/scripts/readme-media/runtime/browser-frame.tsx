/**
 * A browser around a scene: window controls, tabs, the address bar and the
 * toolbar, drawn here because the README shows Polaris where it is used - in a
 * browser - and a screenshot of a real browser would show whatever that browser
 * had open that day.
 *
 * `SceneWindow` is another scene drawn inside a frame of its own, an iframe at
 * this page's address. Its viewport is the frame's, so a screen that fills the
 * window (`100dvh`) fills the browser's content area rather than running under
 * the toolbar, and a phone-sized one lays itself out the way a phone does.
 */

import { PolarisMark } from "@polaris/ui";
import type { SceneContext, SceneDefinition } from "./scene";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Lock, Minus, Plus, RotateCw, Square, X } from "lucide-react";

/** The page drawn as a phone below this width: one bar, no tabs. */
export const PHONE_WIDTH = 640;

/** The colour of the extension's own mark (`apps/extension/src/entrypoints/autofill.ts`). */
export const EXTENSION_BRAND = "hsl(258 82% 62%)";

export interface BrowserTab {
    readonly title: string;
    /** The tab's icon; a plain dot in `color` when left out. */
    readonly icon?: ReactNode;
    readonly color?: string;
}

/** The browser's own greys, by theme: no part of Polaris's design. */
function shades(ctx: SceneContext) {
    return ctx.theme === "dark"
        ? { strip: "#1f2023", bar: "#2b2c30", field: "#1a1b1e", text: "#e3e3e6", muted: "#9a9ca3", line: "#3a3b40" }
        : { strip: "#dfe1e5", bar: "#f7f8fa", field: "#eceef1", text: "#202124", muted: "#5f6368", line: "#d3d6db" };
}

/** The Polaris star, as a tab icon. */
export function PolarisTabIcon() {
    return <PolarisMark nameClassName="hidden" />;
}

/** The extension's toolbar button: its mark, lit while it is in use. */
function ExtensionButton({ lit }: { lit: boolean }) {
    return (
        <span
            title="Polaris"
            style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                display: "grid",
                placeItems: "center",
                font: "600 11px ui-sans-serif, system-ui, sans-serif",
                color: "#fff",
                background: EXTENSION_BRAND,
                boxShadow: lit ? `0 0 0 3px color-mix(in srgb, ${EXTENSION_BRAND} 35%, transparent)` : "none"
            }}
        >
            P
        </span>
    );
}

function TabIcon({ tab }: { tab: BrowserTab }) {
    if (tab.icon) return <span style={{ display: "flex", flex: "none" }}>{tab.icon}</span>;
    return (
        <i
            style={{
                width: 12,
                height: 12,
                flex: "none",
                borderRadius: 3,
                background: tab.color ?? "#94a3b8"
            }}
        />
    );
}

export function BrowserFrame({
    ctx,
    tabs,
    active = 0,
    url,
    extensionLit = false,
    children
}: {
    ctx: SceneContext;
    tabs: readonly BrowserTab[];
    active?: number;
    url: string;
    /** The extension's toolbar button drawn as in use. */
    extensionLit?: boolean;
    children: ReactNode;
}) {
    const tone = shades(ctx);
    const phone = window.innerWidth < PHONE_WIDTH;
    const [scheme, ...rest] = url.split("://");
    const address = rest.join("://") || scheme!;
    const host = address.split("/")[0]!;
    const path = address.slice(host.length);
    const field = (
        <div
            style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: phone ? 36 : 32,
                borderRadius: 999,
                padding: "0 14px",
                fontSize: 13,
                background: tone.field,
                color: tone.text
            }}
        >
            <Lock size={13} style={{ flex: "none", color: tone.muted }} />
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {host}
                {!phone && <span style={{ color: tone.muted }}>{path}</span>}
            </span>
        </div>
    );
    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                height: "100dvh",
                overflow: "hidden",
                background: tone.bar,
                color: tone.text
            }}
        >
            {phone ? (
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px" }}>
                    {field}
                    <span
                        style={{
                            minWidth: 22,
                            height: 22,
                            borderRadius: 5,
                            border: `1.5px solid ${tone.text}`,
                            display: "grid",
                            placeItems: "center",
                            fontSize: 11,
                            fontWeight: 600
                        }}
                    >
                        {tabs.length}
                    </span>
                </div>
            ) : (
                <>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "flex-end",
                            gap: 2,
                            height: 40,
                            padding: "0 8px 0 14px",
                            background: tone.strip
                        }}
                    >
                        <span style={{ display: "flex", gap: 8, alignSelf: "center", marginRight: 14 }}>
                            {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
                                <i key={color} style={{ width: 12, height: 12, borderRadius: 99, background: color }} />
                            ))}
                        </span>
                        {tabs.map((tab, index) => (
                            <div
                                key={`${tab.title}-${index}`}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    width: 220,
                                    minWidth: 0,
                                    height: 32,
                                    padding: "0 10px 0 12px",
                                    borderRadius: "8px 8px 0 0",
                                    fontSize: 12,
                                    background: index === active ? tone.bar : "transparent",
                                    color: index === active ? tone.text : tone.muted
                                }}
                            >
                                <TabIcon tab={tab} />
                                <span
                                    style={{
                                        flex: 1,
                                        minWidth: 0,
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        whiteSpace: "nowrap"
                                    }}
                                >
                                    {tab.title}
                                </span>
                                <X size={13} style={{ flex: "none" }} />
                            </div>
                        ))}
                        <Plus size={15} style={{ alignSelf: "center", margin: "0 8px", color: tone.muted }} />
                        <span style={{ flex: 1 }} />
                        <span style={{ display: "flex", gap: 18, alignSelf: "center", color: tone.muted }}>
                            <Minus size={14} />
                            <Square size={12} />
                            <X size={14} />
                        </span>
                    </div>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 14,
                            padding: "6px 14px",
                            borderBottom: `1px solid ${tone.line}`,
                            color: tone.muted
                        }}
                    >
                        <ArrowLeft size={16} />
                        <ArrowRight size={16} />
                        <RotateCw size={15} />
                        {field}
                        <ExtensionButton lit={extensionLit} />
                    </div>
                </>
            )}
            <div style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
        </div>
    );
}

type SceneWindowHandle = Window & {
    __scene?: NonNullable<Window["__scene"]>;
    __MISSING__?: string[];
};

/**
 * Another scene, in a frame of its own. With `width` and `height` the frame is
 * that size - the inner screen lays itself out for it - and is scaled to fit
 * the box it is given; without them it fills the box.
 */
export function SceneWindow({
    ctx,
    scene,
    width,
    height,
    query = "",
    title
}: {
    ctx: SceneContext;
    scene: string;
    width?: number;
    height?: number;
    query?: string;
    title: string;
}) {
    const box = useRef<HTMLDivElement>(null);
    const [fit, setFit] = useState({ scale: 1, left: 0, top: 0 });
    useEffect(() => {
        const element = box.current;
        if (!element || !width || !height) return;
        // Scaled to fit the box, and centred in it.
        const measure = () => {
            const scale = Math.min(element.clientWidth / width, element.clientHeight / height);
            setFit({
                scale,
                left: (element.clientWidth - width * scale) / 2,
                top: (element.clientHeight - height * scale) / 2
            });
        };
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [width, height]);
    const src = `${window.location.pathname}?scene=${scene}&theme=${ctx.theme}&locale=${ctx.locale}${query}`;
    const sized = width !== undefined && height !== undefined;
    return (
        <div
            ref={box}
            style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}
        >
            <iframe
                data-scene-window={scene}
                title={title}
                src={src}
                style={{
                    border: 0,
                    display: "block",
                    position: sized ? "absolute" : "static",
                    left: sized ? fit.left : 0,
                    top: sized ? fit.top : 0,
                    width: sized ? width : "100%",
                    height: sized ? height : "100%",
                    transform: sized ? `scale(${fit.scale})` : undefined,
                    transformOrigin: "0 0"
                }}
            />
        </div>
    );
}

function windows(): SceneWindowHandle[] {
    return [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-scene-window]")].map(
        (frame) => frame.contentWindow as SceneWindowHandle
    );
}

const prepared = new WeakSet<Window>();

/**
 * Resolves once every scene window on the page has drawn and done what its
 * scene does before a picture. What one of them asked for and was not answered
 * is reported as this page's, so the capture refuses the picture the same way.
 */
export async function windowsReady(): Promise<void> {
    for (let tries = 0; ; tries++) {
        const all = windows();
        if (all.length > 0 && all.every((one) => one?.__scene?.ready)) break;
        if (tries > 600) throw new Error("a scene window never drew");
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const inner of windows()) {
        if (prepared.has(inner)) continue;
        prepared.add(inner);
        await inner.__scene!.prepare();
    }
    for (const inner of windows())
        for (const what of inner.__MISSING__ ?? []) (globalThis.__MISSING__ ??= []).push(what);
}

/**
 * `inner` drawn in a browser: the same screen, the same animation, with tabs and
 * an address bar around it. The inner scene runs in its own frame, so its
 * answers stay its own; this one answers nothing.
 */
export function framedScene(
    id: string,
    inner: SceneDefinition,
    frame: (ctx: SceneContext) => { tabs: readonly BrowserTab[]; url: string }
): SceneDefinition {
    const animation = inner.animation;
    return {
        id,
        path: inner.path,
        params: inner.params,
        render: (ctx) => {
            const { tabs, url } = frame(ctx);
            return (
                <BrowserFrame ctx={ctx} tabs={tabs} url={url}>
                    <SceneWindow ctx={ctx} scene={inner.id} title={tabs[0]?.title ?? inner.id} />
                </BrowserFrame>
            );
        },
        prepare: windowsReady,
        animation: animation && {
            get frames() {
                return animation.frames;
            },
            step: async (index) => {
                await windowsReady();
                await windows()[0]!.__scene!.step(index);
            },
            hold: (index) => animation.hold(index),
            advance: (index) => animation.advance?.(index) ?? 400
        }
    };
}
