"use client";

/**
 * The first-run setup's three steps: what Polaris is for, the apps that fit, and
 * installing them.
 *
 * Installs run one at a time through the marketplace's own path, each with its
 * own line - waiting, installing, installed, or the reason it failed and a retry
 * - so one app that cannot be had never hides the ones that were. Skipping is
 * offered on every step, and finishing never waits for anything: the screen
 * behind it is usable the whole time.
 *
 * `installed` is null while the server is still saying what this Polaris has;
 * only the app list waits on it, as a skeleton.
 */

import { useEffect, useId, useMemo, useState } from "react";
import { findApp } from "@/lib/apps/catalog";
import { AppMark } from "@/components/app-mark";
import { localizeApp } from "@/lib/apps/app-words";
import { Button, Checkbox, cn, Skeleton } from "@polaris/ui";
import { useNavLabel } from "@/components/i18n/use-nav-label";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { installSetupAppAction } from "@/app/(app)/setup-actions";
import { Check, Loader2, RotateCw, TriangleAlert } from "lucide-react";
import {
    recommendApps,
    SETUP_USE_CASES,
    type InstallStatus,
    type SetupApp,
    type SetupUseCase
} from "@/lib/setup/setup-wizard";

type Step = "uses" | "apps" | "install";

const STEPS: readonly Step[] = ["uses", "apps", "install"];

interface Progress {
    readonly status: InstallStatus;
    readonly error?: string;
}

export function SetupWizard({
    installed,
    onFinish,
    onInstalling,
    install = installSetupAppAction
}: {
    /** The setup's apps already installed; null while that is being asked. */
    installed: readonly SetupApp[] | null;
    /** Called with "done" or "skipped" when the reader leaves the setup. */
    onFinish: (outcome: "done" | "skipped") => void;
    /** Told when installs start and when the last one settles. */
    onInstalling?: (busy: boolean) => void;
    /** The install, injectable so the screen can be exercised without a server. */
    install?: (app: SetupApp) => Promise<{ error?: string }>;
}) {
    const t = useTranslations("setup");
    const words = useTranslations("catalog");
    const navLabel = useNavLabel();
    const uid = useId();
    const [step, setStep] = useState<Step>("uses");
    const [uses, setUses] = useState<readonly SetupUseCase[]>([]);
    // Unticked by hand, so a change of use does not tick them again.
    const [declined, setDeclined] = useState<ReadonlySet<SetupApp>>(new Set());
    const [progress, setProgress] = useState<ReadonlyMap<SetupApp, Progress>>(new Map());

    const have = useMemo(() => new Set(installed ?? []), [installed]);
    const recommended = recommendApps(uses);
    const chosen = recommended.filter((app) => !have.has(app) && !declined.has(app));
    const apps = useMemo(
        () =>
            new Map(
                recommended.flatMap((id) => {
                    const manifest = findApp(id);
                    return manifest ? [[id, localizeApp(words, manifest, navLabel)] as const] : [];
                })
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [recommended.join(), words, navLabel]
    );

    function toggleUse(use: SetupUseCase) {
        setUses((current) =>
            current.includes(use) ? current.filter((one) => one !== use) : [...current, use]
        );
    }

    function toggleApp(app: SetupApp) {
        setDeclined((current) => {
            const next = new Set(current);
            if (next.has(app)) next.delete(app);
            else next.add(app);
            return next;
        });
    }

    function mark(app: SetupApp, value: Progress) {
        setProgress((current) => new Map(current).set(app, value));
    }

    async function runOne(app: SetupApp) {
        mark(app, { status: "installing" });
        try {
            const result = await install(app);
            mark(
                app,
                result.error ? { status: "failed", error: result.error } : { status: "installed" }
            );
        } catch {
            mark(app, { status: "failed", error: t("errors.network") });
        }
    }

    async function runAll(queue: readonly SetupApp[]) {
        setProgress(new Map(queue.map((app) => [app, { status: "waiting" as const }])));
        setStep("install");
        for (const app of queue) await runOne(app);
    }

    const queue = [...progress.keys()];
    const busy = queue.some((app) => {
        const status = progress.get(app)?.status;
        return status === "waiting" || status === "installing";
    });
    useEffect(() => onInstalling?.(busy), [busy, onInstalling]);
    const failed = queue.some((app) => progress.get(app)?.status === "failed");
    const current = STEPS.indexOf(step) + 1;

    return (
        <div className="flex min-w-0 flex-col gap-4">
            <div className="min-w-0">
                <p className="text-xs text-muted-foreground">
                    {t("wizard.step", { current, total: STEPS.length })}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{t("wizard.intro")}</p>
            </div>

            {step === "uses" ? (
                <div
                    role="group"
                    aria-label={t("wizard.useCasesLabel")}
                    className="flex flex-col gap-2"
                >
                    <p className="text-sm font-medium">{t("wizard.useCasesLabel")}</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                        {SETUP_USE_CASES.map((use) => {
                            const on = uses.includes(use);
                            return (
                                <label
                                    key={use}
                                    className={cn(
                                        "flex min-w-0 cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors",
                                        on
                                            ? "border-primary bg-primary/5"
                                            : "border-border hover:bg-muted/50"
                                    )}
                                >
                                    <Checkbox
                                        className="mt-0.5"
                                        checked={on}
                                        onChange={() => toggleUse(use)}
                                        aria-describedby={`${uid}-use-${use}`}
                                    />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate text-sm font-medium">
                                            {t(`wizard.useCases.${use}.title`)}
                                        </span>
                                        <span
                                            id={`${uid}-use-${use}`}
                                            className="text-xs text-muted-foreground"
                                        >
                                            {t(`wizard.useCases.${use}.body`)}
                                        </span>
                                    </span>
                                </label>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            {step === "apps" ? (
                <div className="flex flex-col gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("wizard.appsLabel")}</p>
                        <p className="text-xs text-muted-foreground">{t("wizard.appsHint")}</p>
                    </div>
                    {installed === null ? (
                        <div
                            className="flex flex-col gap-2"
                            aria-label={t("wizard.loading")}
                            aria-busy
                        >
                            {recommended.map((app) => (
                                <Skeleton key={app} className="h-12 w-full" />
                            ))}
                        </div>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {recommended.map((id) => {
                                const app = apps.get(id);
                                if (!app) return null;
                                const present = have.has(id);
                                return (
                                    <li key={id}>
                                        <label
                                            className={cn(
                                                "flex min-w-0 items-start gap-3 rounded-md border px-3 py-2",
                                                present
                                                    ? "cursor-default"
                                                    : "cursor-pointer hover:bg-muted/50"
                                            )}
                                        >
                                            <Checkbox
                                                className="mt-1.5"
                                                checked={present || !declined.has(id)}
                                                disabled={present}
                                                onChange={() => toggleApp(id)}
                                                aria-label={app.name}
                                                aria-describedby={`${uid}-app-${id}`}
                                            />
                                            <AppMark app={app} size={28} className="shrink-0" />
                                            <span className="flex min-w-0 flex-1 flex-col">
                                                <span className="flex min-w-0 items-center gap-2">
                                                    <span
                                                        className="truncate text-sm font-medium"
                                                        title={app.name}
                                                    >
                                                        {app.name}
                                                    </span>
                                                    {present ? (
                                                        <span className="shrink-0 text-xs text-muted-foreground">
                                                            {t("wizard.status.installed")}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <span
                                                    id={`${uid}-app-${id}`}
                                                    className="text-xs text-muted-foreground"
                                                >
                                                    {app.summary}
                                                </span>
                                                {app.consent && !present ? (
                                                    <span className="text-xs text-muted-foreground">
                                                        {t("wizard.consent", {
                                                            label: app.consent.label
                                                        })}{" "}
                                                        <a
                                                            href={app.consent.url}
                                                            target="_blank"
                                                            rel="noreferrer noopener"
                                                            className="break-all underline"
                                                        >
                                                            {app.consent.url.replace(
                                                                /^https?:\/\//,
                                                                ""
                                                            )}
                                                        </a>
                                                    </span>
                                                ) : null}
                                            </span>
                                        </label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    {installed !== null &&
                    recommended.length > 0 &&
                    chosen.length === 0 &&
                    declined.size === 0 ? (
                        <p className="text-xs text-muted-foreground">{t("wizard.noneNeeded")}</p>
                    ) : null}
                </div>
            ) : null}

            {step === "install" ? (
                <ul className="flex flex-col gap-2" aria-live="polite">
                    {queue.map((id) => {
                        const app = apps.get(id);
                        const state = progress.get(id);
                        if (!app || !state) return null;
                        return (
                            <li
                                key={id}
                                className="flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <AppMark app={app} size={24} className="shrink-0" />
                                    <span
                                        className="min-w-0 flex-1 truncate text-sm font-medium"
                                        title={app.name}
                                    >
                                        {app.name}
                                    </span>
                                    <StatusLabel
                                        status={state.status}
                                        label={t(`wizard.status.${state.status}`)}
                                    />
                                    {state.status === "failed" ? (
                                        <Button
                                            size="sm"
                                            variant="secondary"
                                            onClick={() => void runOne(id)}
                                            aria-label={t("wizard.retryNamed", { app: app.name })}
                                        >
                                            <RotateCw aria-hidden className="size-3.5 shrink-0" />
                                            {t("wizard.retry")}
                                        </Button>
                                    ) : null}
                                </div>
                                {state.error ? (
                                    <p className="text-xs text-danger">{state.error}</p>
                                ) : null}
                            </li>
                        );
                    })}
                </ul>
            ) : null}

            {step === "install" && !busy ? (
                <p className="text-sm text-muted-foreground">
                    {failed ? t("wizard.someFailed") : t("wizard.allDone")} {t("wizard.reopenHint")}
                </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
                {step === "install" ? (
                    <span />
                ) : (
                    <Button variant="ghost" size="sm" onClick={() => onFinish("skipped")}>
                        {t("wizard.skip")}
                    </Button>
                )}
                <div className="flex flex-wrap items-center gap-2">
                    {step === "apps" ? (
                        <Button variant="secondary" size="sm" onClick={() => setStep("uses")}>
                            {t("wizard.back")}
                        </Button>
                    ) : null}
                    {step === "uses" ? (
                        <Button
                            size="sm"
                            disabled={uses.length === 0}
                            onClick={() => setStep("apps")}
                        >
                            {t("wizard.next")}
                        </Button>
                    ) : null}
                    {step === "apps" ? (
                        chosen.length > 0 ? (
                            <Button
                                size="sm"
                                disabled={installed === null}
                                onClick={() => void runAll(chosen)}
                            >
                                {t("wizard.install", { count: chosen.length })}
                            </Button>
                        ) : (
                            <Button
                                size="sm"
                                disabled={installed === null}
                                onClick={() => onFinish("done")}
                            >
                                {t("wizard.finish")}
                            </Button>
                        )
                    ) : null}
                    {step === "install" ? (
                        <Button size="sm" disabled={busy} onClick={() => onFinish("done")}>
                            {t("wizard.finish")}
                        </Button>
                    ) : null}
                </div>
            </div>
            {step === "uses" && uses.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("wizard.noApps")}</p>
            ) : null}
        </div>
    );
}

function StatusLabel({ status, label }: { status: InstallStatus; label: string }) {
    return (
        <span
            className={cn(
                "flex shrink-0 items-center gap-1 text-xs",
                status === "failed" ? "text-danger" : "text-muted-foreground"
            )}
        >
            {status === "installing" ? (
                <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin" />
            ) : null}
            {status === "installed" ? (
                <Check aria-hidden className="size-3.5 shrink-0 text-success" />
            ) : null}
            {status === "failed" ? (
                <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
            ) : null}
            {label}
        </span>
    );
}
