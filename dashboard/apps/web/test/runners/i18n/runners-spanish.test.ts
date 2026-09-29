/**
 * Runners, in Spanish.
 *
 * What the reconcile loop, the machine probe, the shared schemas and the job
 * guard write down is English, and reaches the screen through
 * `lib/runners/words`: the English catalog is held to those sentences here - the
 * ones core itself produces, not copies of them - and a sample of each is read in
 * Spanish.
 */

import { describe, expect, it } from "vitest";
import {
    estimateRunnerCapacity,
    evaluateRunnerAccess,
    repoServingRefusal,
    runnerTargetRefusal,
    secretKeyRefusal,
    secretValueRefusal
} from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { KNOWN_RUNNER_NOTES, runnerText, scopeSummaryText } from "@/lib/runners/words";

const english = translatorFor("en-US", "runners");
const spanish = translatorFor("es-ES", "runners");

const GB = 1024 ** 3;
const roomy = estimateRunnerCapacity({ cpus: 8, memoryBytes: 32 * GB, diskFreeBytes: 200 * GB });
const cramped = estimateRunnerCapacity({ cpus: 1, memoryBytes: 1 * GB, diskFreeBytes: 1 * GB });
const policy = { events: ["push" as const], allowForks: false, allowPublic: false, secrets: false };

/** Sentences core writes, produced by core rather than copied from it. */
const FROM_CORE = [
    roomy.note,
    cramped.refusal ?? "",
    cramped.note,
    estimateRunnerCapacity({ cpus: 0, memoryBytes: 0, diskFreeBytes: null }).note,
    repoServingRefusal(policy, "public") ?? "",
    repoServingRefusal({ ...policy, events: [] }, "private") ?? "",
    secretKeyRefusal("") ?? "",
    secretKeyRefusal("1abc") ?? "",
    secretKeyRefusal("GITHUB_TOKEN") ?? "",
    secretValueRefusal("a\nb") ?? "",
    evaluateRunnerAccess({ method: null }).advice ?? "",
    evaluateRunnerAccess({ method: "app", installations: [] }).advice ?? "",
    evaluateRunnerAccess({ method: "pat", patScopes: null }).advice ?? "",
    evaluateRunnerAccess({ method: "pat", patScopes: ["read:user"] }).advice ?? "",
    runnerTargetRefusal(evaluateRunnerAccess({ method: "app", installations: [] }), "repo", "acme") ?? ""
];

const SHAPED = [
    "Used 120 of 100 minutes this month.",
    "Ran 5 of 5 jobs allowed today.",
    "acme/site: Used 12 of 10 minutes today.",
    "3 repositories are over their budget this window.",
    "Stopped serving acme/a, acme/b, acme/c and 2 more.",
    "Jobs started by 'schedule' are not allowed on this runner.",
    "This pull request's code comes from mallory/site, which is a fork of acme/site. Pull requests from forks are not allowed on this runner.",
    `This machine is worth about 2 jobs at once (${roomy.note}).`,
    "GitHub publishes no runner for this system on this processor."
];

describe("the English the runner service writes", () => {
    it("comes back exactly as it went in", () => {
        for (const message of [...KNOWN_RUNNER_NOTES, ...FROM_CORE, ...SHAPED]) {
            expect(message).not.toBe("");
            expect(runnerText(english, message)).toBe(message);
        }
    });

    it("sums a scope up as the service did", () => {
        expect(scopeSummaryText(english, { scope: "org", targets: [{ key: "acme" }] })).toBe("acme (organization)");
        expect(scopeSummaryText(english, { scope: "account", targets: [] })).toBe("nothing yet");
        expect(scopeSummaryText(english, { scope: "account", targets: [{ key: "a/b" }, { key: "a/c" }] })).toBe(
            "2 repositories"
        );
    });
});

describe("in Spanish", () => {
    it("reads what a machine has", () => {
        expect(runnerText(spanish, roomy.note)).toMatch(/^8 procesadores, 32 GB de memoria, 200 GB libres: hay sitio para unos \d+ trabajos a la vez\.$/);
        expect(runnerText(spanish, cramped.refusal ?? "")).toMatch(/^1 procesador, 1 GB de memoria, 1 GB libres no basta/);
    });

    it("reads a budget, a guard refusal and a repository's reason", () => {
        expect(runnerText(spanish, "acme/site: Used 12 of 10 minutes today.")).toBe("acme/site: Usados 12 de 10 minutos hoy.");
        expect(runnerText(spanish, "Jobs started by 'schedule' are not allowed on this runner.")).toBe(
            "En este runner no se permiten trabajos iniciados por 'schedule'."
        );
        expect(runnerText(spanish, repoServingRefusal({ ...policy, events: [] }, "private") ?? "")).toBe(
            "Aquí no se permite ejecutar nada: no hay ningún evento activado."
        );
    });

    it("leaves a machine's own error as it came", () => {
        expect(runnerText(spanish, "ssh: connect to host 10.0.0.5 port 22: Connection refused")).toBe(
            "ssh: connect to host 10.0.0.5 port 22: Connection refused"
        );
    });
});
