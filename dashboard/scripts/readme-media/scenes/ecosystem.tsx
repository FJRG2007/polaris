/**
 * One Polaris on every device it has a client for: the desktop app, a phone
 * (the installable web app), the servers it runs on, the browser extension and
 * a TV. Each screen is another scene, drawn in a frame of its own at that
 * device's size, so the phone shows the phone layout. The TV is the Polaris TV
 * launcher's home (tv/launcher, `MainActivity`): greeting, clock and date, the
 * Polaris pill with the account's unread count beside Settings, then a row of
 * apps. There is no watch client, so there is no watch here.
 */

import type { ReactNode } from "react";
import { PolarisMark } from "@polaris/ui";
import { Minus, Square, X } from "lucide-react";
import { defineScene, type SceneContext } from "../runtime/scene";
import { PHONE_WIDTH, SceneWindow, windowsReady } from "../runtime/browser-frame";

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function tones(ctx: SceneContext) {
    return ctx.theme === "dark"
        ? { page: "#0d0e11", device: "#1c1d21", edge: "#34363c", text: "#e3e3e6", muted: "#9a9ca3" }
        : {
              page: "#eef0f3",
              device: "#ffffff",
              edge: "#d3d6db",
              text: "#202124",
              muted: "#5f6368"
          };
}

/** A device and the name under it. */
function Tile({
    ctx,
    name,
    area,
    children
}: {
    ctx: SceneContext;
    name: string;
    area: string;
    children: ReactNode;
}) {
    return (
        <figure
            style={{
                gridArea: area,
                margin: 0,
                minWidth: 0,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8
            }}
        >
            <div style={{ flex: 1, minHeight: 0, display: "flex", justifyContent: "center" }}>
                {children}
            </div>
            <figcaption style={{ textAlign: "center", fontSize: 13, color: tones(ctx).muted }}>
                {name}
            </figcaption>
        </figure>
    );
}

/** The desktop app's window: its title bar, then Polaris. */
function AppWindow({ ctx, scene }: { ctx: SceneContext; scene: string }) {
    const tone = tones(ctx);
    return (
        <div
            style={{
                width: "100%",
                display: "flex",
                flexDirection: "column",
                borderRadius: 10,
                overflow: "hidden",
                border: `1px solid ${tone.edge}`,
                background: tone.device,
                boxShadow: "0 18px 40px rgb(0 0 0 / 0.25)"
            }}
        >
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    height: 28,
                    padding: "0 12px",
                    fontSize: 12,
                    color: tone.muted
                }}
            >
                <PolarisMark />
                <span style={{ flex: 1 }} />
                <Minus size={12} />
                <Square size={10} />
                <X size={12} />
            </div>
            <SceneWindow ctx={ctx} scene={scene} {...DESKTOP} title={scene} />
        </div>
    );
}

/** A phone: rounded glass, a camera, Polaris filling the screen. */
function Phone({ ctx, scene }: { ctx: SceneContext; scene: string }) {
    const tone = tones(ctx);
    const ratio = (PHONE.width + 24) / (PHONE.height + 24);
    // Sized from whichever side of the tile runs out first. Height 100% with a
    // max width broke the aspect ratio on a narrow tile, and the screen inside
    // sat in a frame taller than itself with an empty band at the top.
    return (
        <div
            style={{
                width: "100%",
                height: "100%",
                containerType: "size",
                display: "flex",
                alignItems: "center",
                justifyContent: "center"
            }}
        >
            <div
                style={{
                    width: `min(100cqw, calc(100cqh * ${ratio}))`,
                    aspectRatio: `${PHONE.width + 24} / ${PHONE.height + 24}`,
                    display: "flex",
                    padding: 8,
                    borderRadius: 34,
                    background: "#0b0b0d",
                    border: `2px solid ${tone.edge}`,
                    boxShadow: "0 18px 40px rgb(0 0 0 / 0.3)",
                    position: "relative"
                }}
            >
                <div style={{ flex: 1, display: "flex", borderRadius: 26, overflow: "hidden" }}>
                    <SceneWindow ctx={ctx} scene={scene} {...PHONE} title={scene} />
                </div>
                <i
                    style={{
                        position: "absolute",
                        top: 14,
                        left: "50%",
                        width: 64,
                        height: 16,
                        marginLeft: -32,
                        borderRadius: 99,
                        background: "#0b0b0d"
                    }}
                />
            </div>
        </div>
    );
}

/** A server: the screen Polaris watches it from. */
function Server({ ctx, scene }: { ctx: SceneContext; scene: string }) {
    const tone = tones(ctx);
    return (
        <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
            <div
                style={{
                    flex: 1,
                    display: "flex",
                    borderRadius: 8,
                    overflow: "hidden",
                    border: `1px solid ${tone.edge}`,
                    boxShadow: "0 12px 30px rgb(0 0 0 / 0.2)"
                }}
            >
                <SceneWindow ctx={ctx} scene={scene} {...DESKTOP} title={scene} />
            </div>
        </div>
    );
}

/** A TV on its stand, showing the Polaris TV launcher's home. */
function Tv({ ctx }: { ctx: SceneContext }) {
    const tone = tones(ctx);
    const apps = [
        ["#7632ec", ctx.say("Polaris", "Polaris")],
        ["#0f766e", ctx.say("Live TV", "TV en directo")],
        ["#b45309", ctx.say("Music", "Música")],
        ["#1d4ed8", ctx.say("Photos", "Fotos")]
    ] as const;
    const pill = {
        display: "flex",
        alignItems: "center",
        gap: "0.8cqw",
        padding: "0.9cqw 2.2cqw",
        borderRadius: 99,
        background: "rgb(255 255 255 / 0.08)",
        border: "1px solid rgb(255 255 255 / 0.14)",
        fontSize: "2.2cqw",
        color: "#f1f1f3"
    } as const;
    return (
        <div
            style={{
                width: "100%",
                height: "100%",
                containerType: "size",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center"
            }}
        >
            <div
                style={{
                    width: "min(100cqw, calc((100cqh - 18px) * 16 / 9))",
                    aspectRatio: "16 / 9",
                    boxSizing: "border-box",
                    padding: 6,
                    borderRadius: 10,
                    background: "#0b0b0d",
                    border: `2px solid ${tone.edge}`,
                    boxShadow: "0 18px 40px rgb(0 0 0 / 0.3)",
                    display: "flex"
                }}
            >
                <div
                    style={{
                        flex: 1,
                        minWidth: 0,
                        containerType: "inline-size",
                        borderRadius: 4,
                        overflow: "hidden",
                        padding: "5cqw 6cqw",
                        display: "flex",
                        flexDirection: "column",
                        color: "#f1f1f3",
                        background:
                            "radial-gradient(circle at 30% 35%, rgb(118 50 236 / 0.55), transparent 60%), #0d0b16"
                    }}
                >
                    <div style={{ display: "flex", alignItems: "flex-start", gap: "1.6cqw" }}>
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: "1.6cqw", letterSpacing: "0.2em", opacity: 0.6 }}>
                                {ctx.say("GOOD EVENING", "BUENAS TARDES")}
                            </div>
                            <div style={{ fontSize: "6.5cqw", fontWeight: 300, lineHeight: 1.1 }}>
                                {ctx.say("8:30", "20:30")}
                                <span style={{ fontSize: "2cqw", marginLeft: "0.6cqw", opacity: 0.7 }}>
                                    {ctx.say("PM", "")}
                                </span>
                            </div>
                        </div>
                        <span style={pill}>Polaris 3</span>
                        <span style={pill}>{ctx.say("Settings", "Ajustes")}</span>
                    </div>
                    <div style={{ flex: 1 }} />
                    <div style={{ fontSize: "4.2cqw", marginBottom: "1.6cqw" }}>{apps[0][1]}</div>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "repeat(4, 1fr)",
                            gap: "1.6cqw",
                            padding: "1.2cqw",
                            borderRadius: "1.8cqw",
                            background: "rgb(255 255 255 / 0.05)",
                            border: "1px solid rgb(255 255 255 / 0.1)"
                        }}
                    >
                        {apps.map(([color, name], index) => (
                            <div
                                key={name}
                                style={{
                                    aspectRatio: "16 / 9",
                                    borderRadius: "1.2cqw",
                                    display: "grid",
                                    placeItems: "center",
                                    fontSize: "2.4cqw",
                                    fontWeight: 600,
                                    background: color,
                                    outline: index === 0 ? "2px solid #ffffff" : "none",
                                    outlineOffset: 1
                                }}
                            >
                                {name}
                            </div>
                        ))}
                    </div>
                </div>
            </div>
            <i style={{ width: 70, height: 10, background: tone.edge, borderRadius: "0 0 6px 6px" }} />
        </div>
    );
}

/** The extension at work: its own scene, browser and all. */
function Extension({ ctx, scene }: { ctx: SceneContext; scene: string }) {
    const tone = tones(ctx);
    return (
        <div
            style={{
                width: "100%",
                display: "flex",
                borderRadius: 10,
                overflow: "hidden",
                border: `1px solid ${tone.edge}`,
                boxShadow: "0 12px 30px rgb(0 0 0 / 0.2)"
            }}
        >
            <SceneWindow ctx={ctx} scene={scene} {...DESKTOP} title={scene} />
        </div>
    );
}

function Ecosystem({ ctx }: { ctx: SceneContext }) {
    const phone = window.innerWidth < PHONE_WIDTH;
    return (
        <div
            style={{
                height: "100dvh",
                display: "grid",
                gap: phone ? 14 : 28,
                padding: phone ? 16 : 40,
                background: tones(ctx).page,
                color: tones(ctx).text,
                gridTemplateColumns: phone ? "1fr 1fr" : "1.3fr 1fr 0.62fr",
                gridTemplateRows: phone ? "1fr 0.7fr 0.7fr 0.9fr" : "1.15fr 1fr",
                gridTemplateAreas: phone
                    ? '"app app" "phone tv" "phone server" "extension extension"'
                    : '"app tv phone" "server extension phone"'
            }}
        >
            <Tile ctx={ctx} area="app" name={ctx.say("Desktop app", "App de escritorio")}>
                <AppWindow ctx={ctx} scene="chat" />
            </Tile>
            <Tile ctx={ctx} area="phone" name={ctx.say("Phone", "Móvil")}>
                <Phone ctx={ctx} scene="tasks" />
            </Tile>
            <Tile ctx={ctx} area="tv" name={ctx.say("Smart TV", "Smart TV")}>
                <Tv ctx={ctx} />
            </Tile>
            <Tile ctx={ctx} area="server" name={ctx.say("Your servers", "Tus servidores")}>
                <Server ctx={ctx} scene="watch" />
            </Tile>
            <Tile
                ctx={ctx}
                area="extension"
                name={ctx.say("Browser extension", "Extensión del navegador")}
            >
                <Extension ctx={ctx} scene="extension-autofill" />
            </Tile>
        </div>
    );
}

export const ecosystem = defineScene({
    id: "ecosystem",
    path: "/",
    render: (ctx) => <Ecosystem ctx={ctx} />,
    prepare: windowsReady
});
