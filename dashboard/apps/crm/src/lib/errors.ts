/**
 * A refusal the person can act on, in their words. Only this is shown on a
 * screen; anything else thrown below an action is logged and replaced with a
 * generic sentence, because a database's message names internals.
 */
export class CrmRefusal extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "CrmRefusal";
    }
}
