import craftLogo from "@/assets/craft_logo_c.svg"

interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon - Displays the Kata logo (colorful "C" icon)
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={craftLogo}
      alt="Kata"
      width={size}
      height={size}
      className={className}
    />
  )
}
