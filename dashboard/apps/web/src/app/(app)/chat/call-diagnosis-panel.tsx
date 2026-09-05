"use client";

/**
 * The call saying why it is silent.
 *
 * A call with no sound in it used to have nothing on screen at all. Every
 * control said what it was set to, every face was drawn, the ring lit up when
 * somebody talked, and none of that is evidence that a single packet moved -
 * so two people sat looking at a working-looking call that neither of them
 * could hear. The one thing Polaris did offer was a floating pill asking for a
 * press, which answers a completely different question and did nothing when it
 * was pressed.
 *
 * So the call says it. One sentence naming what is wrong, one saying what to do
 * about it, and the four things that were checked underneath so the reader can
 * see the check that failed rather than being asked to believe a verdict.
 *
 * Nothing here asks anybody to open a terminal, edit a file or read a log. The
 * furthest it goes is naming a Polaris screen an administrator can look at,
 * which is where that answer actually lives.
 *
 * Drawn only when something is wrong. Muting yourself, being alone in a call and
 * being deliberately quiet for a room are not faults, and a panel that appeared
 * for those is one people learn to look past - which costs exactly the call it
 * was built for. The verdict itself is `call-diagnosis`; this only draws it.
 */

import { cn } from "@polaris/ui";
import { AlertTriangle } from "lucide-react";
import type { CallAudioReport } from "./call-diagnosis";

export function CallDiagnosisPanel({ audio }: { audio: CallAudioReport }) {
    if (audio.ok || !audio.headline) return null;

    return (
        <section
            role="status"
            aria-label="Why this call has no sound"
            className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        >
            <p className="flex items-start gap-2 text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 font-medium">{audio.headline}</span>
            </p>
            {audio.fix && <p className="pl-[1.375rem] text-muted-foreground">{audio.fix}</p>}
            <dl className="flex flex-col gap-1 pl-[1.375rem]">
                {audio.lines.map((line) => (
                    <div key={line.label} className="flex items-baseline gap-3">
                        <dt className="w-40 shrink-0 text-muted-foreground">{line.label}</dt>
                        <dd
                            className={cn(
                                "min-w-0 flex-1 truncate",
                                line.state === "bad" && "text-warning",
                                line.state === "good" && "text-success",
                                line.state === "idle" && "text-muted-foreground"
                            )}
                        >
                            {line.value}
                        </dd>
                    </div>
                ))}
            </dl>
        </section>
    );
}
