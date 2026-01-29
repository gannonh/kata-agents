import iconSvg from "@/assets/kata_mark.svg"

interface KataSymbolProps {
  className?: string
}

/**
 * Kata symbol - the app icon mark
 */
export function KataSymbol({ className }: KataSymbolProps) {
  return (
    <img
      src={iconSvg}
      alt=""
      className={className}
    />
  )
}
