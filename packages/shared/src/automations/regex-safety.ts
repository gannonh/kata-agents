export const MAX_REGEX_LENGTH = 500

export function isPotentiallyCatastrophicRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return true
  const nestedQuantifiers = /\([^)]*[+*][^)]*\)[+*{]/
  const riskyPatterns = /(\.\*){2,}|(\.\+){2,}|\([^)]*\|[^)]*\)[+*{]/
  return nestedQuantifiers.test(pattern) || riskyPatterns.test(pattern)
}
