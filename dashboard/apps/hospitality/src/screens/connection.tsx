"use client";
/**
 * One record per page of how the server is answering, fed by every action
 * call (`unwrap`) and the offline queue, and the banner every Hospitality
 * screen draws from it: "Sin conexion: N pendientes" while the server is away,
 * "Enviando N" while the queue drains, nothing once all is live.
 */
import { useHospitalityT } from "./i18n";
import { CloudOff, RefreshCw } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { degradedState, type ConnectionFacts } from "../model/degraded";

let facts: ConnectionFacts = { online: true, reachable: true, waiting: 0 };
const listeners = new Set<() => void>();

function set(next: Partial<ConnectionFacts>) {
    const merged = { ...facts, ...next };
    if (merged.online === facts.online && merged.reachable === facts.reachable && merged.waiting === facts.waiting) return;
    facts = merged;
    for (const listener of listeners) listener();
}

/** Every call to the server says whether it got an answer. */
export function reportReach(reachable: boolean): void {
    set({ reachable });
}

/** The offline queue says how much waits. */
export function reportWaiting(waiting: number): void {
    set({ waiting });
}

const SERVER: ConnectionFacts = { online: true, reachable: true, waiting: 0 };

export function useConnection(): ConnectionFacts {
    useEffect(() => {
        const update = () => set({ online: navigator.onLine });
        update();
        window.addEventListener("online", update);
        window.addEventListener("offline", update);
        return () => {
            window.removeEventListener("online", update);
            window.removeEventListener("offline", update);
        };
    }, []);
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => facts,
        () => SERVER
    );
}

/** Drawn at the top of every Hospitality screen; empty while everything is live. */
export function DegradedBanner() {
    const t = useHospitalityT();
    const connection = useConnection();
    const state = degradedState(connection);
    // A blip shorter than a second is not news.
    const [shown, setShown] = useState(false);
    useEffect(() => {
        if (state === "live") return setShown(false);
        const timer = setTimeout(() => setShown(true), 1000);
        return () => clearTimeout(timer);
    }, [state]);
    if (!shown || state === "live") return null;
    return (
        <div
            role="status"
            className={
                state === "offline"
                    ? "flex min-w-0 items-center gap-2 bg-amber-500/20 px-3 py-1.5 text-sm font-medium"
                    : "flex min-w-0 items-center gap-2 bg-sky-500/15 px-3 py-1.5 text-sm"
            }
        >
            {state === "offline" ? <CloudOff aria-hidden className="size-4 shrink-0" /> : <RefreshCw aria-hidden className="size-4 shrink-0 animate-spin" />}
            <span className="min-w-0 truncate">
                {state === "offline" ? t("degraded.offline", { count: connection.waiting }) : t("degraded.syncing", { count: connection.waiting })}
            </span>
            {state === "offline" ? <span className="ms-auto hidden shrink-0 text-xs sm:inline">{t("degraded.offlineHint")}</span> : null}
        </div>
    );
}
