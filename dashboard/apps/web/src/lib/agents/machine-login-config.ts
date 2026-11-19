/**
 * How a connection row says it is the machine's own login (`machine-logins.ts`):
 * its config names the login's variable. Pure, so the screens read it too.
 */

/** The config key that marks a row as the machine's own login. */
export const MACHINE_LOGIN = "machineLogin";

/** The login variable a row stands for, or null when it is any other row. */
export function machineLoginEnv(config: Record<string, unknown> | string): string | null {
    let read: unknown = config;
    if (typeof config === "string") {
        try {
            read = JSON.parse(config);
        } catch {
            return null;
        }
    }
    if (!read || typeof read !== "object" || Array.isArray(read)) return null;
    const env = (read as Record<string, unknown>)[MACHINE_LOGIN];
    return typeof env === "string" && env ? env : null;
}

export function isMachineLogin(config: Record<string, unknown> | string): boolean {
    return machineLoginEnv(config) !== null;
}
