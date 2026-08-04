// LLMs sometimes double-escape JSON strings, producing literal \n \t \"
// instead of actual newline/tab/quote characters.
// detected when the string contains literal \n but no actual newlines.
export function fixDoubleEscapedString(str: string): string {
  if (!str.includes("\n") && str.includes("\\n")) {
    return str.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
  }
  return str;
}
