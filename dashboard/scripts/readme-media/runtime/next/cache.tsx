/** Server-only in Next: a client bundle only meets it through code it never runs. */
export const revalidatePath = () => undefined;
export const revalidateTag = () => undefined;
export const unstable_cache = <T,>(fn: T) => fn;
export const unstable_noStore = () => undefined;
