/** A refusal the screens put into words by its code. */
export class AutomationAccessError extends Error {
    constructor(
        readonly code:
            | "notFound"
            | "forbidden"
            | "limit"
            | "invalid"
            | "notPublished"
            | "noManualTrigger"
            | "secretMissing"
            | "noTrigger"
            | "triggerGone"
            | "tooLarge"
            | "webhookUnavailable"
    ) {
        super(code);
        this.name = "AutomationAccessError";
    }
}
