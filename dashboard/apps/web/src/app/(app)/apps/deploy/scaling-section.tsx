"use client";

/**
 * A service's copies, what each may use, and how traffic is spread over them.
 *
 * A count or a limit applies as soon as it is saved: the running release is started again
 * from its kept image, so nothing is rebuilt and the copies already running stay
 * up. The form checks every field against the same schema the server does, as it
 * is typed.
 */

import * as core from "@polaris/core";
import { Badge, Input, Switch } from "@polaris/ui";
import { sameSettings, withFields } from "./settings-form";
import { CardError, CardSkeleton, LearnMore, SaveBar, SettingsCard } from "./settings-kit";
import { describeServiceEvent } from "./service-history";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { RelativeTime } from "@/components/relative-time";
import { mergeUnchanged } from "@/lib/structural-merge";
import { useKeptSnapshot } from "@/components/use-live-resource";
import { dropSnapshots, writeSnapshot } from "@/lib/snapshot-cache";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { ServiceScalingView } from "@/lib/deploy/scaling-service";
import { saveServiceScalingAction, serviceScalingAction } from "./scaling-actions";

interface Draft {
    replicas: string;
    autoscale: boolean;
    min: string;
    max: string;
    cpuPercent: string;
    /** Blank is no traffic target: scaled on CPU alone. */
    requestsPerCopy: string;
    sticky: boolean;
    healthPath: string;
    cpus: string;
    memoryMb: string;
    sleeps: boolean;
    sleepAfter: string;
}

function draftOf(view: ServiceScalingView): Draft {
    return {
        replicas: String(view.replicas),
        autoscale: view.autoscale !== null,
        min: String(view.autoscale?.min ?? 1),
        max: String(view.autoscale?.max ?? Math.max(2, view.replicas)),
        cpuPercent: String(view.autoscale?.cpuPercent ?? 50),
        requestsPerCopy: view.autoscale?.requestsPerCopy
            ? String(view.autoscale.requestsPerCopy)
            : "",
        sticky: view.balancing.sticky,
        healthPath: view.balancing.healthPath ?? "",
        cpus: view.limits.cpus === null ? "" : String(view.limits.cpus),
        memoryMb: view.limits.memoryMb === null ? "" : String(view.limits.memoryMb),
        sleeps: view.sleepAfterMinutes !== null,
        sleepAfter: String(view.sleepAfterMinutes ?? 30)
    };
}

/** The draft as the server takes it, or the first thing wrong with it. */
function parse(draft: Draft, t: NamespaceTranslator<"deployService">) {
    const input = {
        replicas: Number(draft.replicas),
        autoscale: draft.autoscale
            ? {
                  min: Number(draft.min),
                  max: Number(draft.max),
                  cpuPercent: Number(draft.cpuPercent),
                  requestsPerCopy: draft.requestsPerCopy.trim()
                      ? Number(draft.requestsPerCopy)
                      : null
              }
            : null,
        balancing: { sticky: draft.sticky, healthPath: draft.healthPath.trim() || null },
        // Blank is no limit, not zero.
        limits: {
            cpus: draft.cpus.trim() ? Number(draft.cpus) : null,
            memoryMb: draft.memoryMb.trim() ? Number(draft.memoryMb) : null
        },
        sleepAfterMinutes: draft.sleeps ? Number(draft.sleepAfter) : null
    };
    const parsed = core.serviceScalingSchema
        .extend({
            balancing: core.edgeBalancingSchema,
            limits: core.resourceLimitsSchema,
            sleepAfterMinutes: core.serviceSleepSchema
        })
        .safeParse(input);
    return parsed.success
        ? { input: parsed.data, problem: null }
        : { input: null, problem: parsed.error.issues[0]?.message ?? t("scaling.checkSettings") };
}

/** How old a kept copy may be and still paint the first frame. */
const SNAPSHOT_MAX_AGE_MS = 24 * 3_600_000;

/** The cards the scaling settings are split into, and the fields each saves. */
type ScalingCard = "copies" | "sleep" | "resources" | "balancing";
const CARD_KEYS: Record<ScalingCard, readonly (keyof Draft)[]> = {
    copies: ["replicas", "autoscale", "min", "max", "cpuPercent", "requestsPerCopy"],
    sleep: ["sleeps", "sleepAfter"],
    resources: ["cpus", "memoryMb"],
    balancing: ["sticky", "healthPath"]
};

export function ScalingSection({
    applicationId,
    onChanged
}: {
    applicationId: string;
    onChanged: () => void;
}) {
    const t = useTranslations("deployService");
    const [view, setView] = useState<ServiceScalingView | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    // The settings as last stored: every save sends the whole set, so a card
    // sends its own fields over these and never a neighbour's unsaved edit.
    const [base, setBase] = useState<Draft | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [errors, setErrors] = useState<Partial<Record<ScalingCard, string | null>>>({});
    const [notes, setNotes] = useState<Partial<Record<ScalingCard, string | null>>>({});
    const [pendingCard, setPendingCard] = useState<ScalingCard | null>(null);
    const [flash, setFlash] = useState<ScalingCard | null>(null);
    const [pending, startTransition] = useTransition();

    // The settings as this tab last read them paint at once, read-only: every
    // field is sent on save, so nothing can be edited or saved until the fresh
    // answer has replaced the kept copy.
    const cacheKey = `deploy.scaling:${applicationId}`;
    const [kept, setKept] = useState(false);
    // Which service has had its answer, so a kept copy never paints over it.
    const answered = useRef<string | null>(null);
    useKeptSnapshot<ServiceScalingView>(cacheKey, SNAPSHOT_MAX_AGE_MS, (snapshot) => {
        if (answered.current === applicationId) return;
        setView(snapshot.value);
        setDraft(draftOf(snapshot.value));
        setBase(draftOf(snapshot.value));
        setKept(true);
    });

    useEffect(() => {
        let active = true;
        void serviceScalingAction(applicationId).then((result) => {
            if (!active) return;
            const fresh = result.scaling;
            if (fresh) {
                answered.current = applicationId;
                writeSnapshot(cacheKey, fresh);
                setView((current) => (current ? mergeUnchanged(current, fresh) : fresh));
                setDraft(draftOf(fresh));
                setBase(draftOf(fresh));
                setKept(false);
            } else setError(result.error ?? t("scaling.unreadable"));
        });
        return () => {
            active = false;
        };
    }, [applicationId, cacheKey]);

    useEffect(() => {
        if (!flash) return;
        const timer = setTimeout(() => setFlash(null), 3000);
        return () => clearTimeout(timer);
    }, [flash]);

    const set = (patch: Partial<Draft>) =>
        setDraft((current) => (current ? { ...current, ...patch } : current));
    const copies = Number(draft?.autoscale ? draft.max : draft?.replicas) || 1;
    const checks = useMemo(() => {
        if (!draft || !base) return null;
        const out = {} as Record<ScalingCard, ReturnType<typeof parse>>;
        for (const card of Object.keys(CARD_KEYS) as ScalingCard[]) {
            out[card] = parse(withFields(base, draft, CARD_KEYS[card]), t);
        }
        return out;
    }, [draft, base, t]);

    // A failed read shows only why, as it did before anything was kept.
    if (!draft || !view || !base || !checks || (kept && error)) {
        return error ? (
            <CardError title={t("scaling.copies")} message={error} />
        ) : (
            <>
                <CardSkeleton title={t("scaling.copies")} />
                <CardSkeleton title={t("scaling.sleep")} rows={1} />
                <CardSkeleton title={t("scaling.resources")} rows={1} />
                <CardSkeleton title={t("scaling.balancing")} rows={1} />
            </>
        );
    }

    function save(card: ScalingCard) {
        if (kept || !draft || !base) return;
        const next = withFields(base, draft, CARD_KEYS[card]);
        const input = parse(next, t).input;
        if (!input) return;
        setErrors((current) => ({ ...current, [card]: null }));
        setNotes((current) => ({ ...current, [card]: null }));
        setPendingCard(card);
        startTransition(async () => {
            const result = await saveServiceScalingAction(applicationId, input);
            setPendingCard(null);
            if (result.error) {
                setErrors((current) => ({ ...current, [card]: result.error ?? null }));
                return;
            }
            // The kept copy is the settings before this save; the next visit reads
            // the saved ones instead of painting the old ones first.
            dropSnapshots(cacheKey);
            setBase(next);
            setFlash(card);
            if (result.redeployed) {
                setNotes((current) => ({ ...current, [card]: t("scaling.savedRedeploying") }));
            }
            onChanged();
        });
    }

    const dirty = (card: ScalingCard) =>
        !sameSettings(
            CARD_KEYS[card].map((key) => draft[key]),
            CARD_KEYS[card].map((key) => base[key])
        );
    const bar = (card: ScalingCard) => (
        <SaveBar
            dirty={dirty(card) && !kept}
            pending={pending && pendingCard === card}
            justSaved={flash === card}
            invalid={checks[card].problem}
            error={errors[card]}
            onSave={() => save(card)}
            onDiscard={() => setDraft(withFields(draft, base, CARD_KEYS[card]))}
        />
    );
    const note = (card: ScalingCard) =>
        notes[card] ? <p className="text-xs text-muted-foreground">{notes[card]}</p> : null;

    return (
        <>
            <SettingsCard
                title={t("scaling.copies")}
                description={t("scaling.copiesHint", { max: core.REPLICAS_MAX })}
                footer={bar("copies")}
            >
                <fieldset disabled={kept} className="flex min-w-0 flex-col gap-3">
                    {view.single && <p className="text-xs text-muted-foreground">{view.single}</p>}
                    <Input
                        type="number"
                        min={1}
                        max={core.REPLICAS_MAX}
                        value={draft.replicas}
                        disabled={view.single !== null || draft.autoscale}
                        onChange={(event) => set({ replicas: event.target.value })}
                        aria-label={t("scaling.copies")}
                        className="w-28"
                    />
                    <div className="flex items-start justify-between gap-3 rounded-md bg-surface p-3">
                        <span className="min-w-0">
                            <span className="text-xs font-medium">{t("scaling.autoscale")}</span>
                            <span className="block text-xs text-muted-foreground">
                                {t("scaling.autoscaleShort")}
                                {view.engine === "swarm" && t("scaling.notOnSwarm")}
                            </span>
                        </span>
                        <Switch
                            checked={draft.autoscale}
                            onChange={(value) => set({ autoscale: value })}
                            disabled={view.single !== null || view.engine === "swarm"}
                            aria-label={t("scaling.autoscale")}
                        />
                    </div>
                    {draft.autoscale && (
                        <div className="flex flex-wrap gap-3">
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{t("scaling.fewest")}</span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REPLICAS_MAX}
                                    value={draft.min}
                                    onChange={(event) => set({ min: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">{t("scaling.most")}</span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REPLICAS_MAX}
                                    value={draft.max}
                                    onChange={(event) => set({ max: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    {t("scaling.cpuTarget")}
                                </span>
                                <Input
                                    type="number"
                                    min={5}
                                    max={90}
                                    value={draft.cpuPercent}
                                    onChange={(event) => set({ cpuPercent: event.target.value })}
                                    className="w-24"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-xs text-muted-foreground">
                                    {t("scaling.requestsPerCopy")}
                                </span>
                                <Input
                                    type="number"
                                    min={1}
                                    max={core.REQUESTS_PER_COPY_MAX}
                                    value={draft.requestsPerCopy}
                                    // A stored target can still be cleared where it cannot be read.
                                    disabled={
                                        view.trafficBlocked !== null &&
                                        !draft.requestsPerCopy.trim()
                                    }
                                    onChange={(event) =>
                                        set({ requestsPerCopy: event.target.value })
                                    }
                                    placeholder={t("scaling.cpuOnly")}
                                    className="w-44"
                                />
                            </label>
                        </div>
                    )}
                    {draft.autoscale && view.trafficBlocked && (
                        <p className="text-xs text-muted-foreground">{view.trafficBlocked}</p>
                    )}
                    {draft.autoscale && view.lastAutoscale && (
                        <p className="text-xs text-muted-foreground">
                            {describeServiceEvent(view.lastAutoscale, t)}{" "}
                            <span className="text-foreground-subtle">
                                <RelativeTime iso={view.lastAutoscale.createdAt} />
                            </span>
                        </p>
                    )}
                    <LearnMore>{t("scaling.autoscaleHint", { minutes: core.AUTOSCALE_IDLE_AFTER })}</LearnMore>
                    {note("copies")}
                </fieldset>
            </SettingsCard>

            <SettingsCard
                title={t("scaling.sleep")}
                description={t("scaling.sleepShort")}
                badge={view.asleep ? <Badge variant="neutral">{t("scaling.asleepNow")}</Badge> : undefined}
                learnMore={t("scaling.sleepHint")}
                actions={
                    <Switch
                        checked={draft.sleeps}
                        onChange={(value) => set({ sleeps: value })}
                        disabled={kept || (view.sleepBlocked !== null && !draft.sleeps)}
                        aria-label={t("scaling.sleep")}
                    />
                }
                footer={bar("sleep")}
            >
                {view.sleepBlocked && <p className="text-xs text-warning-ink">{view.sleepBlocked}</p>}
                {draft.sleeps && (
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("scaling.sleepAfter")}</span>
                        <Input
                            type="number"
                            min={core.SLEEP_AFTER_MIN_MINUTES}
                            max={core.SLEEP_AFTER_MAX_MINUTES}
                            value={draft.sleepAfter}
                            disabled={kept}
                            onChange={(event) => set({ sleepAfter: event.target.value })}
                            className="w-28"
                        />
                    </label>
                )}
                {note("sleep")}
            </SettingsCard>

            <SettingsCard
                title={t("scaling.resources")}
                description={t("scaling.resourcesHint")}
                footer={bar("resources")}
            >
                <fieldset disabled={kept} className="flex flex-wrap gap-3">
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("scaling.cpus")}</span>
                        <Input
                            type="number"
                            min={0.05}
                            step={0.05}
                            value={draft.cpus}
                            onChange={(event) => set({ cpus: event.target.value })}
                            placeholder={t("scaling.noLimit")}
                            className="w-28"
                        />
                    </label>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{t("scaling.memory")}</span>
                        <Input
                            type="number"
                            min={16}
                            step={64}
                            value={draft.memoryMb}
                            onChange={(event) => set({ memoryMb: event.target.value })}
                            placeholder={t("scaling.noLimit")}
                            className="w-28"
                        />
                    </label>
                </fieldset>
                {note("resources")}
            </SettingsCard>

            <SettingsCard title={t("scaling.balancing")} description={t("scaling.balancingShort")} footer={bar("balancing")}>
                <fieldset disabled={kept} className="flex min-w-0 flex-col gap-3">
                    <div className="flex items-start justify-between gap-3 rounded-md bg-surface p-3">
                        <span className="min-w-0">
                            <span className="text-xs font-medium">{t("scaling.sticky")}</span>
                            <span className="block text-xs text-muted-foreground">{t("scaling.stickyHint")}</span>
                        </span>
                        <Switch
                            checked={draft.sticky}
                            onChange={(value) => set({ sticky: value })}
                            aria-label={t("scaling.sticky")}
                        />
                    </div>
                    <label className="flex flex-col gap-1">
                        <span className="text-xs font-medium">{t("scaling.healthPath")}</span>
                        <Input
                            value={draft.healthPath}
                            onChange={(event) => set({ healthPath: event.target.value })}
                            // i18n-ignore: an example path
                            placeholder="/healthz"
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className="max-w-xs font-mono"
                        />
                        <span className="text-xs text-muted-foreground">
                            {t("scaling.healthPathHint")}
                        </span>
                    </label>
                    {copies > 1 && (
                        <p className="text-xs text-muted-foreground">{t("scaling.emailShield")}</p>
                    )}
                    {note("balancing")}
                </fieldset>
            </SettingsCard>
        </>
    );
}
