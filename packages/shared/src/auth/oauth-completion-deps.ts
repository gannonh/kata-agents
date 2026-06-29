import type { LoadedSource } from '../sources/types.ts';
import type { AuthResult } from '../sources/credential-manager.ts';
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
  ): Promise<AuthResult>;
}

export interface OAuthSessionManagerLike {
  completeAuthRequest(sessionId: string, authRequestId: string, sourceSlug: string): Promise<void>;
}

export interface OAuthCompletionDeps {
  flowStore: OAuthFlowStoreLike;
  credManager: OAuthCredManagerLike;
  sessionManager: OAuthSessionManagerLike;
  pushSourcesChanged: (workspaceId: string) => void;
}
