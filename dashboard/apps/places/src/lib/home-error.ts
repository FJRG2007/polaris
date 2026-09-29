/**
 * A refusal written to be read.
 *
 * The difference between this and any other error is who it was written for. A
 * screen may show one of these word for word, because somebody chose the words;
 * anything else that reaches an action is a fault, and a fault's own words are
 * about columns and drivers. Putting those in front of the person adding a
 * camera tells them nothing they can act on and everything about the schema.
 *
 * Every deliberate refusal in Places throws one, and the actions show only
 * these. It is the same shape Chat and Tasks already use.
 *
 * On its own, importing nothing: a screen's test should be able to ask what it
 * would be shown without standing up a session and a database first.
 */
export class HomeError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "HomeError";
    }
}
