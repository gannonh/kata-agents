interface KataAgentsSymbolProps {
  className?: string
}

/**
 * Kata Agents app icon symbol - matches resources/icon.svg.
 * Tan (#d4a574) kanji mark on a dark (#18181b) rounded square.
 */
export function KataAgentsSymbol({ className }: KataAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="64" height="64" rx="14" fill="#18181b" />
      <g transform="translate(10, 9)">
        <rect x="0" y="0" width="44" height="7" rx="3.5" fill="#d4a574" />
        <rect x="0" y="15" width="24" height="7" rx="3.5" fill="#d4a574" />
        <rect x="18" y="7" width="7" height="15" rx="3.5" fill="#d4a574" />
        <rect x="0" y="30" width="44" height="7" rx="3.5" fill="#d4a574" />
        <rect x="18" y="37" width="7" height="9" rx="3.5" fill="#d4a574" />
      </g>
    </svg>
  )
}
