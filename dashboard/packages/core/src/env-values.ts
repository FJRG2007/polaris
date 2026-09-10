/**
 * What a container's environment can hold.
 *
 * The host daemon refuses to start a container whose environment carries a
 * control character - anything below a space, and DEL - because the values are
 * rendered into a compose file, where a newline writes YAML of its own. Its
 * refusal names the variable in words nobody can act on, and only once a deploy
 * has already started. The same rule, here, is what lets every place a value
 * comes in say so first, in a sentence naming the variable.
 */

/** The longest value one variable may hold, typed or once its references are
 *  filled in. */
export const ENV_VALUE_MAX = 64 * 1024;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Whether the host daemon would refuse this as an environment value. */
export function hasControlCharacter(value: string): boolean {
    return CONTROL.test(value);
}

/** Why a variable's value cannot be given to a container. */
export function envValueMessage(key: string): string {
    return `${key} contains a line break, tab or other control character, which a container's environment cannot hold.`;
}

/** Throw, naming the variable, on the first value a container cannot be given. */
export function assertEnvValues(env: Readonly<Record<string, string>>): void {
    for (const [key, value] of Object.entries(env)) {
        if (hasControlCharacter(value)) throw new Error(envValueMessage(key));
    }
}
