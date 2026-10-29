/** A storage of its own: the test environment's may be missing or shared. */
export function useMemoryStorage(): void {
    const items = new Map<string, string>();
    const storage: Storage = {
        get length() {
            return items.size;
        },
        key: (index: number) => Array.from(items.keys())[index] ?? null,
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, String(value)),
        removeItem: (key: string) => void items.delete(key),
        clear: () => items.clear()
    };
    Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}
