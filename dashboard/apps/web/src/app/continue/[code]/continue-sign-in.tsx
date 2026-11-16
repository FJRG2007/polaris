"use client";

import { Smartphone } from "lucide-react";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { pollContinueAction, startContinueAction } from "./actions";

export interface ContinueWords {
    readonly title: string;
    readonly waiting: string;
    readonly approved: string;
    readonly denied: string;
    readonly gone: string;
    readonly busy: string;
}

/** Waits on the computer's PIN, then opens the session. */
export function ContinueSignIn({ code, words }: { code: string; words: ContinueWords }) {
    const router = useRouter();
    const [line, setLine] = useState<string>(words.waiting);
    const [done, setDone] = useState(false);

    useEffect(() => {
        let live = true;
        let timer: ReturnType<typeof setTimeout> | null = null;
        void startContinueAction(code)
            .then((started) => {
                if (!live) return;
                if ("error" in started) {
                    setLine(started.error === "busy" ? words.busy : words.gone);
                    setDone(true);
                    return;
                }
                const poll = async () => {
                    const status = await pollContinueAction(started.deviceCode).catch(() => "pending" as const);
                    if (!live) return;
                    if (status === "approved") {
                        setLine(words.approved);
                        router.refresh();
                        return;
                    }
                    if (status !== "pending") {
                        setLine(status === "denied" ? words.denied : words.gone);
                        setDone(true);
                        return;
                    }
                    timer = setTimeout(() => void poll(), started.pollMs);
                };
                timer = setTimeout(() => void poll(), started.pollMs);
            })
            .catch(() => live && (setLine(words.gone), setDone(true)));
        return () => {
            live = false;
            if (timer) clearTimeout(timer);
        };
    }, [code, router, words]);

    return (
        <div className="mx-auto flex w-full max-w-sm min-w-0 flex-col items-center gap-4 px-4 py-12 text-center">
            <Smartphone className="size-8 shrink-0 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold">{words.title}</h1>
            <p className={done ? "text-sm text-danger" : "text-sm text-muted-foreground"} aria-live="polite">
                {line}
            </p>
        </div>
    );
}
