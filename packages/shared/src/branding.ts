/**
 * Centralized branding assets for Kata Agent
 * Used by OAuth callback pages
 */

export const CRAFT_LOGO = [
  '███  ████  █████  █████  ████  █████ █████',
  ' ██   ██  ██   ██ ██   ██  ██  ██    ██   ',
  ' ██   ██  ██████ ███████  ██  ████  █████',
  ' ██   ██  ██   ██ ██   ██  ██  ██       ██',
  '███  ████ ██   ██ ██   ██ ████ █████ █████',
] as const;

/** Logo as a single string for HTML templates */
export const CRAFT_LOGO_HTML = CRAFT_LOGO.map((line) => line.trimEnd()).join('\n');

/** Kata app icon SVG mark (tan kanji on dark rounded square) */
export const KATA_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <rect width="64" height="64" rx="14" fill="#18181b"/>
  <g transform="translate(10, 9)">
    <rect x="0" y="0" width="44" height="7" rx="3.5" fill="#d4a574"/>
    <rect x="0" y="15" width="24" height="7" rx="3.5" fill="#d4a574"/>
    <rect x="18" y="7" width="7" height="15" rx="3.5" fill="#d4a574"/>
    <rect x="0" y="30" width="44" height="7" rx="3.5" fill="#d4a574"/>
    <rect x="18" y="37" width="7" height="9" rx="3.5" fill="#d4a574"/>
  </g>
</svg>`;

/** Session viewer base URL */
export const VIEWER_URL = 'https://agents.craft.do';
