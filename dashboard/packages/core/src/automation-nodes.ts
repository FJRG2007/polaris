/**
 * A short random id for one node of an automation - a trigger, a condition, a
 * group or a step - unique within that automation.
 *
 * Shared by every editor that builds one (Places' device automations, Mail's
 * filters) and by the server code that starts one from a template. Not a uuid:
 * an editor may run on a plain-http address where `crypto.randomUUID` does not
 * exist, and nothing outside one automation compares these.
 */
export function automationNodeId(): string {
    return Math.random().toString(36).slice(2, 12).padEnd(6, "0");
}
