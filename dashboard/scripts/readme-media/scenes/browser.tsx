/**
 * Polaris in the browser: the extension filling a sign-in form from the vault,
 * and the Vault itself in a tab.
 *
 * The sign-in page is an invented site at a reserved address, drawn here only
 * as the page the extension works on. The mark and the chooser are drawn the
 * way the extension's content script draws them (`apps/extension/src/
 * entrypoints/autofill.ts`: `mark()`, `floating()` and `list()`), with its own
 * words; that script runs inside a real page and cannot be mounted here.
 */

import { vault } from "./vault";
import { VIEWER } from "../fixtures/people";
import { useEffect, useState } from "react";
import { defineScene, type SceneContext } from "../runtime/scene";
import extensionEn from "../../../apps/extension/src/messages/en-US.json";
import extensionEs from "../../../apps/extension/src/messages/es-ES.json";
import {
    BrowserFrame,
    EXTENSION_BRAND,
    PHONE_WIDTH,
    PolarisTabIcon,
    framedScene
} from "../runtime/browser-frame";

/** The invented site: its name, address and colour. */
const SITE = {
    name: "Example Cloud",
    url: "https://login.example.com/sign-in",
    brand: "#2563eb"
};

/** The logins the vault holds for that site, as the chooser lists them. */
function savedLogins(ctx: SceneContext) {
    return [
        { name: SITE.name, detail: `${VIEWER.email} - ${ctx.say("Personal", "Personal")}` },
        { name: `${SITE.name} (ops)`, detail: `ops@example.com - ${ctx.say("Team", "Equipo")}` }
    ];
}

/** The loop: the mark on the box, the chooser open, the form filled. */
const PLAY = [{ hold: 1200 }, { hold: 2000 }, { hold: 2800 }] as const;

/** The step on screen; the still is the chooser open. */
let current = 1;
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

/** The extension's mark, in the corner of a box it has something for. */
function Mark({ title }: { title: string }) {
    return (
        <span
            title={title}
            style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                width: 18,
                height: 18,
                borderRadius: 5,
                display: "grid",
                placeItems: "center",
                font: "600 11px ui-sans-serif, system-ui, sans-serif",
                color: "#fff",
                background: EXTENSION_BRAND
            }}
        >
            P
        </span>
    );
}

/** The chooser under the box: the extension's panel, dark on every page. */
function Chooser({ ctx }: { ctx: SceneContext }) {
    return (
        <div
            style={{
                position: "absolute",
                top: "calc(100% + 4px)",
                left: 0,
                width: "100%",
                maxWidth: 340,
                zIndex: 2,
                border: "1px solid hsl(225 10% 16%)",
                borderRadius: 8,
                overflow: "hidden",
                background: "hsl(225 11% 9%)",
                color: "hsl(220 14% 96%)",
                font: "13px/1.4 ui-sans-serif, system-ui, sans-serif",
                boxShadow: "0 8px 24px rgb(0 0 0 / 0.35)"
            }}
        >
            {savedLogins(ctx).map((login, index) => (
                <div
                    key={login.name}
                    style={{
                        padding: "8px 12px",
                        background: index === 0 ? "hsl(225 12% 13%)" : "transparent"
                    }}
                >
                    <span style={{ display: "block" }}>{login.name}</span>
                    <span style={{ display: "block", fontSize: 12, color: "hsl(222 10% 66%)" }}>
                        {login.detail}
                    </span>
                </div>
            ))}
        </div>
    );
}

function Field({
    label,
    value,
    children
}: {
    label: string;
    value: string;
    children?: React.ReactNode;
}) {
    return (
        <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }}>
            <span style={{ fontWeight: 500 }}>{label}</span>
            <span style={{ position: "relative", display: "block" }}>
                <span
                    style={{
                        display: "block",
                        height: 40,
                        lineHeight: "40px",
                        padding: "0 34px 0 12px",
                        borderRadius: 8,
                        border: "1px solid #cbd5e1",
                        background: value ? "#eef4ff" : "#fff",
                        overflow: "hidden",
                        whiteSpace: "nowrap",
                        textOverflow: "ellipsis"
                    }}
                >
                    {value}
                </span>
                {children}
            </span>
        </label>
    );
}

/** The invented sign-in page, with the extension working on it. */
function SignInPage({ ctx, step }: { ctx: SceneContext; step: number }) {
    const words = (ctx.locale === "es-ES" ? extensionEs : extensionEn).inline;
    const filled = step >= 2;
    const phone = window.innerWidth < PHONE_WIDTH;
    return (
        <div
            style={{
                flex: 1,
                minWidth: 0,
                display: "grid",
                placeItems: phone ? "start stretch" : "center",
                padding: phone ? 16 : 24,
                background: "#f1f5f9",
                color: "#0f172a"
            }}
        >
            <div
                style={{
                    width: "100%",
                    maxWidth: 380,
                    justifySelf: "center",
                    display: "flex",
                    flexDirection: "column",
                    gap: 16,
                    padding: 28,
                    borderRadius: 14,
                    background: "#fff",
                    boxShadow: "0 10px 30px rgb(15 23 42 / 0.08)"
                }}
            >
                <b style={{ fontSize: 18, color: SITE.brand }}>{SITE.name}</b>
                <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>
                    {ctx.say("Sign in to your account", "Inicia sesión en tu cuenta")}
                </h1>
                <Field label={ctx.say("Email", "Correo")} value={filled ? VIEWER.email : ""}>
                    {!filled && <Mark title={words.marks.login} />}
                    {step === 1 && <Chooser ctx={ctx} />}
                </Field>
                <Field
                    label={ctx.say("Password", "Contraseña")}
                    value={filled ? "•".repeat(14) : ""}
                />
                <span
                    style={{
                        textAlign: "center",
                        padding: "10px 0",
                        borderRadius: 8,
                        fontWeight: 600,
                        fontSize: 14,
                        color: "#fff",
                        background: SITE.brand,
                        boxShadow: filled ? `0 0 0 3px ${SITE.brand}40` : "none"
                    }}
                >
                    {ctx.say("Sign in", "Iniciar sesión")}
                </span>
            </div>
        </div>
    );
}

function Autofill({ ctx }: { ctx: SceneContext }) {
    const step = useStep();
    return (
        <BrowserFrame
            ctx={ctx}
            tabs={[
                {
                    title: ctx.say(`Sign in - ${SITE.name}`, `Iniciar sesión - ${SITE.name}`),
                    color: SITE.brand
                },
                { title: "Vault - Polaris", icon: <PolarisTabIcon /> }
            ]}
            url={SITE.url}
            extensionLit={step >= 1}
        >
            <SignInPage ctx={ctx} step={step} />
        </BrowserFrame>
    );
}

export const extensionAutofill = defineScene({
    id: "extension-autofill",
    path: "/vault",
    render: (ctx) => <Autofill ctx={ctx} />,
    animation: {
        frames: PLAY.length,
        step: (index) => {
            current = index;
            for (const listener of listeners) listener(index);
        },
        hold: (index) => PLAY[index]!.hold,
        advance: () => 600
    }
});

export const vaultBrowser = framedScene("vault-browser", vault, (ctx) => ({
    tabs: [
        { title: "Vault - Polaris", icon: <PolarisTabIcon /> },
        {
            title: ctx.say(`Sign in - ${SITE.name}`, `Iniciar sesión - ${SITE.name}`),
            color: SITE.brand
        }
    ],
    url: `https://polaris.example.com${vault.path}`
}));
