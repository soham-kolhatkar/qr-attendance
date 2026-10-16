/** ILIKE pattern matching `text` anywhere, with LIKE wildcards in user input escaped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}
