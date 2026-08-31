export const MAX_REGEX_LENGTH = 500

type RegexAtom = {
  kind: 'literal' | 'class' | 'escape' | 'wildcard' | 'group'
  value: string
}

type GroupAnalysis = { hasQuantifier: boolean }

function quantifierEnd(pattern: string, index: number): number | null {
  const character = pattern[index]
  let end: number
  if (character === '+' || character === '*' || character === '?') end = index + 1
  else if (character === '{') {
    const closing = pattern.indexOf('}', index + 1)
    if (closing < 0 || !/^\{\d+(,\d*)?\}$/.test(pattern.slice(index, closing + 1))) return null
    end = closing + 1
  } else return null
  return pattern[end] === '?' ? end + 1 : end
}

function groupPrefixEnd(pattern: string, index: number): number {
  if (pattern[index + 1] !== '?') return index
  if (pattern[index + 2] === '<' && (pattern[index + 3] === '=' || pattern[index + 3] === '!')) return index + 3
  if (pattern[index + 2] === '<') {
    const closing = pattern.indexOf('>', index + 3)
    return closing < 0 ? index + 2 : closing
  }
  return index + 2
}

function hasNestedQuantifiers(pattern: string): boolean {
  const groups: GroupAnalysis[] = []
  let lastAtom: 'atom' | 'group' | null = null
  let lastGroup: GroupAnalysis | null = null

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '\\') {
      lastAtom = 'atom'
      lastGroup = null
      index += 1
      continue
    }
    if (character === '[') {
      for (index += 1; index < pattern.length; index += 1) {
        if (pattern[index] === '\\') index += 1
        else if (pattern[index] === ']') break
      }
      lastAtom = 'atom'
      lastGroup = null
      continue
    }
    if (character === '(') {
      groups.push({ hasQuantifier: false })
      index = groupPrefixEnd(pattern, index)
      lastAtom = null
      lastGroup = null
      continue
    }
    if (character === ')') {
      const group = groups.pop()
      if (group) {
        lastAtom = 'group'
        lastGroup = group
      }
      continue
    }
    if (character === '|') {
      lastAtom = null
      lastGroup = null
      continue
    }
    const end = quantifierEnd(pattern, index)
    if (end !== null) {
      if (lastAtom === 'group' && lastGroup?.hasQuantifier) return true
      for (const group of groups) group.hasQuantifier = true
      index = end - 1
      continue
    }
    lastAtom = 'atom'
    lastGroup = null
  }

  return false
}

function readAtom(pattern: string, index: number): { atom: RegexAtom; end: number } | null {
  const character = pattern[index]
  if (!character || character === '^' || character === '$' || character === '|' || character === ')') return null
  if (character === '\\') return { atom: { kind: 'escape', value: pattern.slice(index, index + 2) }, end: index + 2 }
  if (character === '.') return { atom: { kind: 'wildcard', value: '.' }, end: index + 1 }
  if (character === '[') {
    let end = index + 1
    for (; end < pattern.length; end += 1) {
      if (pattern[end] === '\\') end += 1
      else if (pattern[end] === ']') return { atom: { kind: 'class', value: pattern.slice(index, end + 1) }, end: end + 1 }
    }
    return null
  }
  if (character === '(') {
    let depth = 1
    let end = index + 1
    for (; end < pattern.length; end += 1) {
      if (pattern[end] === '\\') end += 1
      else if (pattern[end] === '[') {
        while (++end < pattern.length && pattern[end] !== ']') if (pattern[end] === '\\') end += 1
      } else if (pattern[end] === '(') depth += 1
      else if (pattern[end] === ')' && --depth === 0) return { atom: { kind: 'group', value: pattern.slice(index, end + 1) }, end: end + 1 }
    }
    return null
  }
  if (character === '+' || character === '*' || character === '?' || character === '{') return null
  return { atom: { kind: 'literal', value: character }, end: index + 1 }
}

function atomsOverlap(left: RegexAtom, right: RegexAtom): boolean {
  if (left.kind === 'wildcard' || right.kind === 'wildcard' || left.kind === 'group' || right.kind === 'group') return true
  if (left.kind === 'literal' && right.kind === 'literal') return left.value === right.value
  if (left.kind === 'escape' && right.kind === 'escape') return left.value === right.value || left.value === '\\w' || right.value === '\\w'
  if (left.kind === 'class' && right.kind === 'class') return true
  if (left.kind === 'class' && right.kind === 'literal') return left.value.includes(right.value)
  if (left.kind === 'literal' && right.kind === 'class') return right.value.includes(left.value)
  return false
}

function hasAdjacentOverlappingQuantifiers(pattern: string): boolean {
  let previous: RegexAtom | null = null
  for (let index = 0; index < pattern.length;) {
    const parsed = readAtom(pattern, index)
    if (!parsed) {
      previous = null
      index += 1
      continue
    }
    const end = quantifierEnd(pattern, parsed.end)
    if (end === null) {
      previous = null
      index = parsed.end
      continue
    }
    if (previous && atomsOverlap(previous, parsed.atom)) return true
    previous = parsed.atom
    index = end
  }
  return false
}

function splitAlternation(pattern: string): string[] {
  const branches: string[] = []
  let start = 0
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === '\\') {
      index += 1
      continue
    }
    if (pattern[index] === '[') inClass = true
    else if (pattern[index] === ']') inClass = false
    else if (pattern[index] === '|' && !inClass) {
      branches.push(pattern.slice(start, index))
      start = index + 1
    }
  }
  branches.push(pattern.slice(start))
  return branches
}

function hasAmbiguousQuantifiedAlternation(pattern: string): boolean {
  const groups = /\(([^()]*)\)(?:[+*?]|\{\d+(,\d*)?\})(?:\?)?/g
  for (const match of pattern.matchAll(groups)) {
    let body = match[1]!
    if (body.startsWith('?:')) body = body.slice(2)
    else if (body.startsWith('?<')) {
      const closing = body.indexOf('>')
      if (closing >= 0) body = body.slice(closing + 1)
    }
    const branches = splitAlternation(body)
    if (branches.length < 2) continue
    if (branches.some(branch => branch.length === 0 || /[?*]|\{0(?:,|\})/.test(branch))) return true
    const firstAtoms = branches.map(branch => readAtom(branch, 0)?.atom)
    if (firstAtoms.some(atom => !atom) || firstAtoms.some((atom, index) => branches.slice(index + 1).some((_, other) => atomsOverlap(atom!, firstAtoms[index + other + 1]!)))) return true
  }
  return false
}

export function isPotentiallyCatastrophicRegex(pattern: string): boolean {
  if (pattern.length > MAX_REGEX_LENGTH) return true
  if (/\\(?:[1-9]\d*|k<[^>]+>)|\(\?(?:[=!]|<[=!])/.test(pattern)) return true
  return hasNestedQuantifiers(pattern) || hasAdjacentOverlappingQuantifiers(pattern) || hasAmbiguousQuantifiedAlternation(pattern) || /(\.\*){2,}|(\.\+){2,}/.test(pattern)
}
