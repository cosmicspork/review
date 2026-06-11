declare module 'adf-to-md' {
  /** Convert an Atlassian Document Format object to Markdown. Throws on invalid ADF. */
  export function convert(adf: unknown): { result: string; warnings: Set<string> };
}
