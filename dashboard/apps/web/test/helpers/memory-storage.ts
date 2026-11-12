/**
 * Web storage of the test's own. The jsdom environment here may have none, or
 * one shared with other files, so a test that reads what a screen stored gives
 * the window fresh ones.
 */

export function memoryStorage(): Storage {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        key: (index: number) => Array.from(items.keys())[index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear()
    };
}

/** Give the window an empty localStorage and sessionStorage. */
export function freshWebStorage(): void {
    Object.defineProperty(window, "localStorage", { value: memoryStorage(), configurable: true });
    Object.defineProperty(window, "sessionStorage", { value: memoryStorage(), configurable: true });
}
