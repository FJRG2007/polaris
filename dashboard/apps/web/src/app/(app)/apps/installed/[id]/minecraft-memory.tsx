"use client";

/**
 * Who decides this server's memory, and how far it may go.
 *
 * The heap used to be a number typed once, when the server was created, and
 * never looked at again - which is survivable until somebody installs a mod
 * loader and six mods on a server sized for a handful of friends. What that
 * looks like from inside the game is not an error message: chunks stop
 * appearing, mobs stand still, and the tick rate reads a perfect twenty. Nobody
 * is going to work that out from a settings screen, so the screen offers to do
 * the watching instead.
 *
 * Automatic keeps the figure in step with what the server actually is, never
 * past the ceiling set here and never past what the machine can spare. Fixed is
 * the old behaviour, and is what every server keeps until somebody switches it.
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import { Badge, Card, CardBody, Select, Skeleton } from "@polaris/ui";
import { readMemoryPlanAction, setMemoryPlanAction, type MemoryPlanView } from "./minecraft-actions";

/** The ceilings worth offering. Past eight gigabytes the answer is a second
 *  server rather than a bigger heap - the pauses the collector takes on one that
 *  size are felt in the game. */
const CEILINGS = [2048, 3072, 4096, 6144, 8192, 12288, 16384];

function inGigabytes(megabytes: number): string {
    return megabytes % 1024 === 0 ? `${megabytes / 1024} GB` : `${megabytes} MB`;
}

export function MinecraftMemory({
    installedAppId,
    refresh = 0
}: {
    installedAppId: string;
    /** Changes whenever something else on the page saved, so the card reads the
     *  figure that save left behind. */
    refresh?: number;
}) {
    const [plan, setPlan] = useState<MemoryPlanView | null>(null);
    /** Null while the first read is out; a sentence when there is nothing to plan
     *  (a Bedrock server runs no JVM) or the read failed. */
    const [note, setNote] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const read = useCallback(async () => {
        const answer = await readMemoryPlanAction(installedAppId);
        if (answer.plan) {
            setPlan(answer.plan);
            setNote(null);
            return;
        }
        setNote(answer.error ?? "Could not read the memory plan");
    }, [installedAppId]);

    useEffect(() => {
        void read();
    }, [read, refresh]);

    function save(next: Partial<Pick<MemoryPlanView, "mode" | "ceilingMb">>): void {
        if (!plan) return;
        const wanted = { mode: plan.mode, ceilingMb: plan.ceilingMb, ...next };
        // Shown as chosen straight away; the answer replaces it with what was
        // actually stored, including the new figure the plan settled on.
        const previous = plan;
        setPlan({ ...plan, ...wanted });
        setNote(null);
        startTransition(async () => {
            const answer = await setMemoryPlanAction(installedAppId, wanted).catch(() => ({
                plan: undefined,
                error: "Could not save the plan"
            }));
            if (answer.plan) {
                setPlan(answer.plan);
                return;
            }
            setPlan(previous);
            setNote(answer.error ?? "Could not save the plan");
        });
    }

    if (note && !plan) {
        return (
            <Card>
                <CardBody className="py-6 text-center text-sm text-muted-foreground">{note}</CardBody>
            </Card>
        );
    }

    return (
        <Card>
            <CardBody className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <p className="text-sm font-medium">Memory</p>
                        <p className="text-xs text-muted-foreground">
                            How much the server is given to hold the world, the mods and the people
                            on it.
                        </p>
                    </div>
                    {plan && <Badge>{inGigabytes(plan.currentMb)} now</Badge>}
                </div>

                {!plan ? (
                    <Skeleton className="h-24 w-full" />
                ) : (
                    <>
                        <label className="flex flex-col gap-1 text-sm">
                            <span>Decided by</span>
                            <Select
                                value={plan.mode}
                                onValueChange={(value) =>
                                    save({ mode: value === "auto" ? "auto" : "fixed" })
                                }
                                options={[
                                    { value: "auto", label: "Polaris, from what the server runs" },
                                    { value: "fixed", label: "The figure under Settings" }
                                ]}
                            />
                        </label>

                        {plan.mode === "auto" ? (
                            <>
                                <label className="flex flex-col gap-1 text-sm">
                                    <span>Never more than</span>
                                    <Select
                                        value={String(plan.ceilingMb)}
                                        onValueChange={(value) =>
                                            save({ ceilingMb: Number.parseInt(value, 10) })
                                        }
                                        options={CEILINGS.map((megabytes) => ({
                                            value: String(megabytes),
                                            label: inGigabytes(megabytes)
                                        }))}
                                    />
                                </label>
                                <p className="text-xs text-muted-foreground">
                                    {plan.plannedMb > plan.currentMb
                                        ? `This server wants ${inGigabytes(plan.plannedMb)} for ${plan.reason}. It picks that up at its next restart.`
                                        : `${inGigabytes(plan.plannedMb)} covers ${plan.reason}, which is what it has.`}{" "}
                                    Polaris raises it when the server grows or runs out, never past{" "}
                                    {inGigabytes(plan.ceilingMb)} and never past what the machine can
                                    spare, and never lowers it on its own.
                                </p>
                            </>
                        ) : (
                            <p className="text-xs text-muted-foreground">
                                The Memory field under Settings decides, and nothing changes it. For
                                what it is running now, this server would be planned{" "}
                                {inGigabytes(plan.plannedMb)} ({plan.reason}).
                            </p>
                        )}
                    </>
                )}

                {pending && <p className="text-xs text-muted-foreground">Saving...</p>}
                {note && plan && <p className="text-sm text-danger">{note}</p>}
            </CardBody>
        </Card>
    );
}
