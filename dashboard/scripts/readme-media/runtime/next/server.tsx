/** Server-only in Next: a client bundle only meets it through code it never runs. */
export class NextResponse extends Response {
    static override json(body: unknown, init?: ResponseInit) {
        return Response.json(body, init);
    }
}
export class NextRequest extends Request {}
export const after = () => undefined;
export const connection = async () => undefined;
