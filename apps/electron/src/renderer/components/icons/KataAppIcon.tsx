import kataLogo from "@/assets/kata_mark.svg"

interface KataAppIconProps {
  className?: string
  size?: number
}

/**
 * KataAppIcon - Displays the Kata logo mark
 */
export function KataAppIcon({ className, size = 64 }: KataAppIconProps) {
  return (
    <img
      src={kataLogo}
      alt="Kata"
      width={size}
      height={size}
      className={className}
    />
  )
}
