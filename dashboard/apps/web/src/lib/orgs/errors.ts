/**
 * What an organization write refuses with.
 *
 * Their own module because every part of the subject throws them - the roster,
 * the teams, the roles, the domains - and the alternative is one of those files
 * importing another purely for an error class, which is a cycle waiting to be
 * written.
 *
 * Both carry a sentence meant for the person who hit it: the action layer passes
 * `message` straight back to the screen, so it says what to do rather than naming
 * a table.
 */

export class OrgError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "OrgError";
    }
}

export class OrgAccessError extends OrgError {
    constructor(message = "You do not have access to that organization") {
        super(message);
        this.name = "OrgAccessError";
    }
}
