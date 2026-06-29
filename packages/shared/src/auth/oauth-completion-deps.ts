import type { AuthResult as SessionAuthResult } from '@kata-sh/session-tools-core';
import type { LoadedSource } from '../sources/types.ts';
import type { AuthResult as CredentialAuthResult } from '../sources/credential-manager.ts';
import type { PendingOAuthFlow } from './oauth-flow-store.ts';
import type { OAuthExchangeParams, OAuthProvider } from './oauth-flow-types.ts';

export interface OAuthFlowStoreLike {
  getByState(state: string): PendingOAuthFlow | null;
  remove(state: string): void;
}

export interface OAuthCredManagerLike {
  exchangeAndStore(
    source: LoadedSource,
    provider: OAuthProvider,
    params: OAuthExchangeParams,
  ): Promise<CredentialAuthResult>;
}

export interface OAuthSessionManagerLike {
  completeAuthRequest(sessionId: string, result: SessionAuthResult): Promise<void>;
}

export interface OAuthCompletionDeps {
  flowStore: OAuthFlowStoreLike;
  credManager: OAuthCredManagerLike;
  sessionManager: OAuthSessionManagerLike;
  pushSourcesChanged: (workspaceId: string) => void;
}
