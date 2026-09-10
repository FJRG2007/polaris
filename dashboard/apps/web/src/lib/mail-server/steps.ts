/**
 * The steps setting a mail server up goes through, in order.
 *
 * A server row records the last one that finished, and running setup again
 * starts after it - so an interrupted setup resumes instead of starting a second
 * engine, and "repair" is the same run started from a chosen step.
 */

export const SETUP_STEPS = [
    // The Deploy service exists: project, image, ports, volumes, domain.
    "service",
    // It is deployed and its container is up.
    "deploy",
    // The engine has left bootstrap mode, named and with its first domain.
    "bootstrap",
    // Polaris's own administrator account exists and its password works.
    "admin",
    // The recovery administrator is gone from the container's environment.
    "recovery-off",
    // The engine posts incoming-mail events to Polaris.
    "webhook",
    // Polaris's own sending mailbox, and the email channel that uses it.
    "sender",
    // The mailbox DMARC reports arrive in, and every domain pointed at it.
    "reports",
    "done"
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

export const SETUP_STEP_LABELS: Readonly<Record<SetupStep, string>> = {
    service: "Creating the service",
    deploy: "Starting the mail server",
    bootstrap: "Naming the server and its first domain",
    admin: "Creating Polaris's administrator account",
    "recovery-off": "Removing the setup credential",
    webhook: "Connecting incoming-mail events",
    sender: "Setting Polaris up to send through it",
    reports: "Setting up the DMARC report mailbox",
    done: "Ready"
};

/** Whether a step has finished, given the last one recorded. */
export function reached(recorded: string, step: SetupStep): boolean {
    const at = SETUP_STEPS.indexOf(recorded as SetupStep);
    return at >= 0 && at >= SETUP_STEPS.indexOf(step);
}

/** The step after the one recorded, where a run resumes. */
export function nextStep(recorded: string): SetupStep {
    const at = SETUP_STEPS.indexOf(recorded as SetupStep);
    return SETUP_STEPS[Math.min(at + 1, SETUP_STEPS.length - 1)] ?? "service";
}
