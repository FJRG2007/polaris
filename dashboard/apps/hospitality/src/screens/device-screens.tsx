"use client";
/**
 * What a handheld, till or kitchen screen shows at `/hospitality-link`: the
 * code to type on the Devices tab while it is not linked, and straight away
 * the work screen (service or kitchen, remembered on the device) once it is.
 * Nobody signs in on the device; it acts for its venue only.
 */
import { TOUCH } from "./touch";
import { useHospitalityT } from "./i18n";
import { ServiceScreen } from "./service-screen";
import { KitchenScreen } from "./kitchen-screen";
import { useEffect, useRef, useState } from "react";
import { Button, ToastProvider } from "@polaris/ui";
import { displayUserCode } from "../model/device-link";

type Started = { readonly deviceCode: string; readonly userCode: string; readonly interval: number };

async function step(body: object): Promise<Record<string, unknown>> {
    const response = await fetch("/api/hospitality/devices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
    });
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

export function LinkScreen() {
    const t = useHospitalityT();
    const [link, setLink] = useState<Started | null>(null);
    const [failed, setFailed] = useState(false);
    const [round, setRound] = useState(0);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        setFailed(false);
        setLink(null);
        step({ step: "start" })
            .then((answer) => {
                if (stopped) return;
                if (typeof answer.deviceCode !== "string" || typeof answer.userCode !== "string") return setFailed(true);
                const started = { deviceCode: answer.deviceCode, userCode: answer.userCode, interval: Number(answer.interval) || 4000 };
                setLink(started);
                let wait = started.interval;
                const poll = () => {
                    timer = setTimeout(async () => {
                        const polled = await step({ step: "poll", deviceCode: started.deviceCode }).catch(() => ({ status: "pending" }));
                        if (stopped) return;
                        if (polled.status === "approved") return window.location.reload();
                        // A new code once this one has expired or was used elsewhere.
                        if (polled.status === "expired" || polled.status === "used") return setRound((n) => n + 1);
                        if (polled.status === "slowDown") wait += started.interval;
                        poll();
                    }, wait);
                };
                poll();
            })
            .catch(() => !stopped && setFailed(true));
        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }, [round]);

    return (
        <main className="flex min-h-dvh min-w-0 flex-col items-center justify-center gap-4 bg-background p-4 text-center">
            <h1 className="text-xl font-semibold">{t("link.title")}</h1>
            <p className="max-w-sm text-sm text-muted-foreground">{t("link.hint")}</p>
            {failed ? (
                <>
                    <p className="text-sm">{t("link.failed")}</p>
                    <Button className={TOUCH} size="lg" onClick={() => setRound((n) => n + 1)}>
                        {t("link.retry")}
                    </Button>
                </>
            ) : (
                <output aria-live="polite" aria-label={t("link.code")} className="min-h-16 font-mono text-4xl font-semibold tracking-widest tabular-nums">
                    {link ? displayUserCode(link.userCode) : "…"}
                </output>
            )}
        </main>
    );
}

type Work = "service" | "kitchen";
const WORK_KEY = "hospitality:device-work";

function readWork(): Work {
    try {
        return localStorage.getItem(WORK_KEY) === "kitchen" ? "kitchen" : "service";
    } catch {
        return "service";
    }
}

/** A linked device: the work screen at once, and one switch between service and kitchen. */
export function DeviceWork(props: { name: string }) {
    const t = useHospitalityT();
    const [work, setWork] = useState<Work>("service");
    const read = useRef(false);
    useEffect(() => {
        if (read.current) return;
        read.current = true;
        setWork(readWork());
    }, []);
    const choose = (next: Work) => {
        setWork(next);
        try {
            localStorage.setItem(WORK_KEY, next);
        } catch {
            // Remembering is a convenience; the switch still works.
        }
    };
    return (
        <ToastProvider>
            <div className="flex min-h-dvh min-w-0 flex-col bg-background">
                <nav className="flex min-w-0 items-center gap-1 border-b px-3 py-1.5" aria-label={t("tabs.label")}>
                    {(["service", "kitchen"] as const).map((x) => (
                        <Button key={x} className={TOUCH} variant={x === work ? "secondary" : "ghost"} aria-pressed={x === work} onClick={() => choose(x)}>
                            {t(`tabs.${x}`)}
                        </Button>
                    ))}
                    <span className="ms-auto min-w-0 truncate text-xs text-muted-foreground" title={props.name}>
                        {props.name}
                    </span>
                </nav>
                {work === "kitchen" ? <KitchenScreen /> : <ServiceScreen manager={false} />}
            </div>
        </ToastProvider>
    );
}
