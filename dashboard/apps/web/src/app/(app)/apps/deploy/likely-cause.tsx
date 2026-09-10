"use client";

/**
 * What a failed deploy's log says went wrong, and the fix for it as one press.
 *
 * Shown under the failed-deploy callout. A fix that needs a value the log cannot
 * give - the start command, a variable's value - asks for it in place, checked as
 * it is typed against the schema the server applies; the others are one button.
 * Either way the setting changes and a new deploy starts.
 */

import * as core from "@polaris/core";
import { Button, Input } from "@polaris/ui";
import { Lightbulb, Loader2 } from "lucide-react";
import type { DeployFix, Diagnosis } from "@polaris/deploy";
import { useEffect, useMemo, useState, useTransition } from "react";
import { applyDeployFixAction, deploymentDiagnosisAction } from "./fix-actions";

/** One answer per failed deploy for the life of the page: its log does not change. */
const answers = new Map<string, Diagnosis | null>();

/** The fix as the server takes it, once any value it asks for is typed. */
function inputFor(fix: DeployFix, typed: string): unknown {
    switch (fix.kind) {
        case "set-start-command":
        case "set-build-command":
        case "set-root-directory":
            return { kind: fix.kind, value: typed };
        case "add-variable":
            return {
                kind: fix.kind,
                name: fix.name,
                value: fix.generate ? null : (fix.value ?? typed),
                generate: fix.generate
            };
        default:
            return fix;
    }
}

/** Whether the fix needs something typed before it can be applied. */
function asks(fix: DeployFix): { label: string; placeholder: string } | null {
    switch (fix.kind) {
        case "set-start-command":
            return { label: "Start command", placeholder: "npm run serve" };
        case "set-build-command":
            return { label: "Build command (blank for none)", placeholder: "npm run build" };
        case "set-root-directory":
            return { label: "Root directory", placeholder: "apps/web" };
        case "add-variable":
            return fix.generate || fix.value !== null
                ? null
                : { label: `Value for ${fix.name}`, placeholder: "" };
        default:
            return null;
    }
}

/** The button's words for a fix that needs nothing typed. */
function pressLabel(fix: DeployFix): string {
    switch (fix.kind) {
        case "set-port":
            return `Use port ${fix.port} and redeploy`;
        case "set-runtime-version":
            return `Build on ${fix.version} and redeploy`;
        case "add-variable":
            return fix.generate
                ? `Generate ${fix.name} and redeploy`
                : `Set ${fix.name} and redeploy`;
        case "use-detected-build":
            return "Build without the Dockerfile";
        default:
            return "Save and redeploy";
    }
}

export function LikelyCause({
    deploymentId,
    canConfigure,
    canSetVariables,
    onFixed
}: {
    deploymentId: string;
    /** Allowed to change the service's settings and deploy it. */
    canConfigure: boolean;
    /** Allowed to change its variables and deploy it. */
    canSetVariables: boolean;
    onFixed: () => void;
}) {
    const [diagnosis, setDiagnosis] = useState<Diagnosis | null | undefined>(() =>
        answers.get(deploymentId)
    );
    const [typed, setTyped] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        if (answers.has(deploymentId)) {
            setDiagnosis(answers.get(deploymentId));
            return;
        }
        let active = true;
        void deploymentDiagnosisAction(deploymentId)
            .catch(() => ({ diagnosis: null }))
            .then((result) => {
                answers.set(deploymentId, result.diagnosis);
                if (active) setDiagnosis(result.diagnosis);
            });
        return () => {
            active = false;
        };
    }, [deploymentId]);

    const fix = diagnosis?.fix ?? null;
    const prompt = fix ? asks(fix) : null;
    const allowed = fix ? (fix.kind === "add-variable" ? canSetVariables : canConfigure) : false;
    const problem = useMemo(() => {
        if (!fix || !prompt) return null;
        // An emptied field is not finished yet rather than wrong, except where
        // empty is itself the answer.
        if (!typed.trim() && fix.kind !== "set-build-command") return null;
        const parsed = core.deployFixInputSchema.safeParse(inputFor(fix, typed));
        return parsed.success ? null : (parsed.error.issues[0]?.message ?? "Check the value");
    }, [fix, prompt, typed]);
    const ready = !prompt || fix?.kind === "set-build-command" || typed.trim().length > 0;

    if (!diagnosis) return null;

    function apply() {
        if (!fix) return;
        setError(null);
        startTransition(async () => {
            const result = await applyDeployFixAction(deploymentId, inputFor(fix, typed));
            if (result.error) setError(result.error);
            else onFixed();
        });
    }

    return (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
            <div className="flex items-start gap-2">
                <Lightbulb className="mt-0.5 size-4 text-primary" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                        Likely cause: {diagnosis.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{diagnosis.detail}</p>
                    <p
                        className="mt-1 truncate font-mono text-xs text-muted-foreground"
                        title={diagnosis.evidence}
                    >
                        {diagnosis.evidence}
                    </p>
                </div>
            </div>
            {fix && allowed && (
                <div className="flex flex-wrap items-end gap-2">
                    {prompt && (
                        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                            {prompt.label}
                            <Input
                                value={typed}
                                onChange={(event) => setTyped(event.target.value)}
                                placeholder={prompt.placeholder}
                                aria-invalid={problem !== null}
                                autoCapitalize="none"
                                autoCorrect="off"
                                spellCheck={false}
                                className="h-8"
                            />
                        </label>
                    )}
                    <Button
                        size="sm"
                        disabled={pending || !ready || problem !== null}
                        onClick={apply}
                    >
                        {pending && <Loader2 className="size-4 animate-spin" />}{" "}
                        {prompt ? "Save and redeploy" : pressLabel(fix)}
                    </Button>
                </div>
            )}
            {problem && <p className="text-xs text-danger">{problem}</p>}
            {error && <p className="text-xs text-danger">{error}</p>}
        </div>
    );
}
