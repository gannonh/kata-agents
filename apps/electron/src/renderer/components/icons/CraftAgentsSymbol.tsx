interface CraftAgentsSymbolProps {
  className?: string
}

/**
 * Kata Agents kanji symbol - the small app mark.
 * Uses accent color from theme (currentColor from className).
 */
export function CraftAgentsSymbol({ className }: CraftAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 44 46"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Kata kanji glyph (形-style bars), monochrome via currentColor */}
      <rect x="0" y="0" width="44" height="7" rx="3.5" fill="currentColor" />
      <rect x="0" y="15" width="24" height="7" rx="3.5" fill="currentColor" />
      <rect x="18" y="7" width="7" height="15" rx="3.5" fill="currentColor" />
      <rect x="0" y="30" width="44" height="7" rx="3.5" fill="currentColor" />
      <rect x="18" y="37" width="7" height="9" rx="3.5" fill="currentColor" />
    </svg>
  )
}
