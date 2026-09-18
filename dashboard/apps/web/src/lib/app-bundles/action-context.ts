/**
 * What an app's server action did besides answering, while it runs.
 *
 * Revalidating is how a server action asks for the screen to be drawn again,
 * and Next only acts on it for its own actions. An app's action is answered by
 * the dashboard (`/api/app-bundles/action`), which runs it inside this context
 * and tells the browser to refresh when the action revalidated anything.
 *
 * On the process rather than in this module, because the route that runs the
 * action and the table that hands an app `next/cache` may be different copies
 * of it.
 *
 * Server-only.
 */

import { AsyncLocalStorage } from "node:async_hooks";

interface ActionContext {
    revalidated: boolean;
}

const storage: AsyncLocalStorage<ActionContext> = ((globalThis as Record<symbol, unknown>)[
    Symbol.for("polaris.app-action-context")
] ??= new AsyncLocalStorage<ActionContext>()) as AsyncLocalStorage<ActionContext>;

/** Run an action, and learn whether it revalidated anything. */
export async function runAction<T>(
    action: () => Promise<T>
): Promise<{ value: T; revalidated: boolean }> {
    const context: ActionContext = { revalidated: false };
    const value = await storage.run(context, action);
    return { value, revalidated: context.revalidated };
}

/** Note that the running action revalidated. Outside one, nothing to note. */
export function markRevalidated(): void {
    const context = storage.getStore();
    if (context) context.revalidated = true;
}
