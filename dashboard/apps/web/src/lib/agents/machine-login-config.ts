/**
 * How a connection row says it is the machine's own login (`machine-logins.ts`):
 * its config names the login's variable, and keeps what the last check of that
 * login found (`{ machineLogin: "<ENV>", checked: { state, at } }`). Pure, so the
 * screens read it too: the row is drawn from its last answer at once, and the
 * rotation skips a login a check found signed out.
 */

/** The config key that marks a row as the machine's own login. */
export const MACHINE_LOGIN = "machineLogin";

/** The login variable a row stands for, or null when it is any other row. */
export function machineLoginEnv(config: Record<string, unknown> | string): string | null {
    const read = configObject(config);
    if (!read) return null;
    const env = read[MACHINE_LOGIN];
    return typeof env === "string" && env ? env : null;
}

/** The config key that keeps the last check of a machine login. */
export const MACHINE_CHECKED = "checked";

/** What the last check of a machine login found, and when (epoch ms). */
export interface MachineLoginCheck {
    readonly state: "in" | "out";
    readonly at: number;
}

function configObject(config: Record<string, unknown> | string): Record<string, unknown> | null {
    let read: unknown = config;
    if (typeof config === "string") {
        try {
            read = JSON.parse(config);
        } catch {
            return null;
        }
    }
    return read && typeof read === "object" && !Array.isArray(read) ? (read as Record<string, unknown>) : null;
}

/** The last stored check of a machine login, or null when it was never checked
 *  (or the row is not one). */
export function machineLoginCheck(config: Record<string, unknown> | string): MachineLoginCheck | null {
    const read = configObject(config);
    if (!read || typeof read[MACHINE_LOGIN] !== "string") return null;
    const checked = read[MACHINE_CHECKED];
    if (!checked || typeof checked !== "object" || Array.isArray(checked)) return null;
    const { state, at } = checked as Record<string, unknown>;
    if ((state !== "in" && state !== "out") || typeof at !== "number" || !Number.isFinite(at)) return null;
    return { state, at };
}

/** A machine login's config with this check kept on it, everything else as it was. */
export function withMachineLoginCheck(config: string, check: MachineLoginCheck): string {
    const read = configObject(config) ?? {};
    return JSON.stringify({ ...read, [MACHINE_CHECKED]: { state: check.state, at: check.at } });
}

/** Whether the last check found this machine login signed out: a login the
 *  rotation must not hand a session to, since the tool would only ask to sign in. */
export function machineLoginSignedOut(config: Record<string, unknown> | string): boolean {
    return machineLoginCheck(config)?.state === "out";
}

export function isMachineLogin(config: Record<string, unknown> | string): boolean {
    return machineLoginEnv(config) !== null;
}
