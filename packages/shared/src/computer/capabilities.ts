import { CLIENT_BROWSER_INVOKE_CAPABILITY, type ComputerKind } from './types.ts'

export function filterCapabilitiesForComputer(
  kind: ComputerKind,
  capabilities: readonly string[],
): readonly string[] {
  if (kind !== 'self-hosted-headless') return capabilities
  return capabilities.filter((capability) => capability !== CLIENT_BROWSER_INVOKE_CAPABILITY)
}
