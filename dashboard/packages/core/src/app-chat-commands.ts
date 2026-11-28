/**
 * The Chat slash commands an installed app declares in its manifest
 * (docs/addons-delivery.md): `/<name> <text>`, its words, and the one
 * permission of the app's own a writer needs. Registered when the manifest is
 * read, so the composer lists it and Chat checks it before the app's bundle is
 * loaded; the bundle only answers.
 */

export interface AppChatCommandDefinition {
    /** What follows the slash: a word, unique across apps. */
    readonly name: string;
    readonly description: string;
    /** What it takes after the name, as a word ("table"); absent for nothing. */
    readonly hint?: string;
    /** What the writer needs: one of the app's own permissions. */
    readonly permission: string;
}

export interface RegisteredAppChatCommand extends AppChatCommandDefinition {
    readonly app: string;
    readonly appName: string;
}

const registry = ((globalThis as Record<symbol, unknown>)[Symbol.for("polaris.app-chat-commands")] ??= new Map()) as Map<
    string,
    RegisteredAppChatCommand
>;

const NAME = /^[a-z][a-z0-9-]{1,31}$/;
/** Names Polaris's own commands use, and words a person reads as Chat's own. */
const RESERVED: ReadonlySet<string> = new Set(["polar", "task", "online", "me", "help", "shrug", "giphy"]);

/**
 * Register (or replace) the commands an app declares. A reserved name, one
 * another app already has, or one behind a permission that is not the app's is
 * left out: the first app to claim a name keeps it.
 */
export function registerAppChatCommands(app: string, appName: string, definitions: readonly AppChatCommandDefinition[]): void {
    for (const [name, command] of registry) if (command.app === app) registry.delete(name);
    for (const definition of definitions.slice(0, 16)) {
        if (!NAME.test(definition.name) || RESERVED.has(definition.name) || registry.has(definition.name)) continue;
        if (!definition.permission.startsWith(`${app}.`)) continue;
        registry.set(definition.name, {
            name: definition.name,
            description: definition.description.slice(0, 200),
            ...(definition.hint ? { hint: definition.hint.slice(0, 40) } : {}),
            permission: definition.permission,
            app,
            appName
        });
    }
}

/** Forget every app's commands except those of `keep`. */
export function retainAppChatCommands(keep: Iterable<string>): void {
    const kept = new Set(keep);
    for (const [name, command] of registry) if (!kept.has(command.app)) registry.delete(name);
}

/** One declared command by its name, or null. */
export function appChatCommand(name: string): RegisteredAppChatCommand | null {
    return registry.get(name) ?? null;
}

/** Every declared command, in the order the apps declared them. */
export function appChatCommands(): RegisteredAppChatCommand[] {
    return [...registry.values()];
}
