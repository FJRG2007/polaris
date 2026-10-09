/**
 * The stand-in for every server action a scene's components import.
 *
 * The bundler replaces each "use server" module with one `dispatch(name)` per
 * export. A call asks the running scene for that name; a name the scene did not
 * answer is recorded and fails the capture, so a screen can never be pictured
 * with a request that quietly went nowhere.
 */

type Handler = (...args: unknown[]) => unknown;

declare global {
    var __ACTIONS__: Record<string, Handler> | undefined;
    var __MISSING__: string[] | undefined;
}

export function dispatch(name: string) {
    return async (...args: unknown[]) => {
        const handler = globalThis.__ACTIONS__?.[name];
        if (!handler) {
            (globalThis.__MISSING__ ??= []).push(`action ${name}`);
            return undefined;
        }
        return handler(...args);
    };
}
