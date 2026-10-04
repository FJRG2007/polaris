/**
 * Whether something looked at `at` is still recent enough to reuse: under
 * `ttlMs` old, and not from the future.
 *
 * A clock that went back - an NTP correction, a host's clock set right, a
 * test's clock wound back - leaves `at` ahead of now, and an age below zero
 * would otherwise read as fresh for as long as the clock is behind: a cache of
 * who reads which language, kept from before, answering for days.
 */
export function fresh(at: number, ttlMs: number, now: number = Date.now()): boolean {
    const age = now - at;
    return age >= 0 && age < ttlMs;
}
