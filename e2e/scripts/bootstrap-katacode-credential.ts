/**
 * Test credential bootstrap for @katacode.
 *
 * Writes a real Katacode token through the credentials subsystem
 * (`katacode::{workspaceId}`). This is not a production fake-provider seam.
 *
 * Usage: bun e2e/scripts/bootstrap-katacode-credential.ts <workspaceId>
 */
import { getCredentialManager } from '../../packages/shared/src/credentials/manager.ts';

const workspaceId = process.argv[2]?.trim();
const token = (process.env.KATA_E2E_KATACODE_TOKEN ?? process.env.KATA_KATACODE_API_KEY ?? '').trim();

if (!workspaceId) {
  throw new Error('bootstrap-katacode-credential: workspaceId argument is required');
}
if (!token) {
  throw new Error(
    'bootstrap-katacode-credential: missing KATA_E2E_KATACODE_TOKEN. See e2e/README.md.',
  );
}

await getCredentialManager().setKatacodeCredential(workspaceId, token);
console.log(`Stored katacode credential for ${workspaceId}`);
