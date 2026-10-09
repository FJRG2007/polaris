/** Server-only in Next: a client bundle only meets it through code it never runs. */
export const headers = async () => new Headers();
export const cookies = async () => ({
    get: () => undefined,
    getAll: () => [],
    set: () => undefined,
    delete: () => undefined,
    has: () => false
});
export const draftMode = async () => ({ isEnabled: false });
