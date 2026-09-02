import {
  KATACODE_ADAPTER_CONTRACT_VERSION,
  type KatacodeAdapter,
  type KatacodeArtifacts,
  type KatacodeCancelResult,
  type KatacodeDeepLink,
  type KatacodeDispatchAcceptance,
  type KatacodeDispatchRequest,
  type KatacodeLookupResult,
  type KatacodeEvidenceItem,
  type KatacodeProviderStatus,
  type KatacodeRunRef,
  type KatacodeStatusResult,
} from '@kata-sh/core';

export interface KatacodeHttpAdapterOptions {
  readonly endpoint: string;
  readonly getCredential: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class KatacodeHttpAdapter implements KatacodeAdapter {
  readonly contractVersion = KATACODE_ADAPTER_CONTRACT_VERSION;
  private readonly endpoint: string;
  private readonly getCredential: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KatacodeHttpAdapterOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, '');
    this.getCredential = options.getCredential;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async dispatch(input: KatacodeDispatchRequest): Promise<KatacodeDispatchAcceptance> {
    const credential = await this.getCredential();
    if (!credential) return { kind: 'rejected', reason: 'Katacode credential is not configured' };
    const response = await this.request('POST', '/v1/runs', {
      idempotencyKey: input.idempotencyKey,
      body: {
        prompt: input.prompt,
        acceptanceCriteria: input.acceptanceCriteria,
        permissionMode: input.permissionMode,
        worktree: input.worktree,
      },
    });
    if (response.kind === 'uncertain') return { kind: 'uncertain' };
    if (response.status === 409 || response.status >= 400 && response.status < 500) {
      return { kind: 'rejected', reason: response.error ?? 'Katacode rejected the dispatch' };
    }
    if (response.status >= 200 && response.status < 300 && typeof response.body?.runId === 'string') {
      return { kind: 'accepted', runRef: { runId: response.body.runId } };
    }
    return { kind: 'uncertain' };
  }

  async lookupByIdempotencyKey(key: string): Promise<KatacodeLookupResult> {
    const response = await this.request('GET', `/v1/runs?idempotencyKey=${encodeURIComponent(key)}`);
    if (response.kind === 'uncertain') return { kind: 'uncertain' };
    if (response.status === 404) return { kind: 'absent' };
    if (response.status >= 200 && response.status < 300 && typeof response.body?.runId === 'string') {
      return {
        kind: 'found',
        runRef: { runId: response.body.runId },
        status: parseStatus(response.body),
      };
    }
    return { kind: 'uncertain' };
  }

  async getStatusAndResult(runRef: KatacodeRunRef): Promise<KatacodeStatusResult> {
    const response = await this.request('GET', `/v1/runs/${encodeURIComponent(runRef.runId)}`);
    if (response.kind === 'uncertain' || response.status >= 400) {
      return { status: { phase: 'running' } };
    }
    return {
      status: parseStatus(response.body ?? {}),
      resultMarkdown: typeof response.body?.resultMarkdown === 'string' ? response.body.resultMarkdown : undefined,
      failureMessage: typeof response.body?.failureMessage === 'string' ? response.body.failureMessage : undefined,
    };
  }

  async cancel(runRef: KatacodeRunRef): Promise<KatacodeCancelResult> {
    const response = await this.request('POST', `/v1/runs/${encodeURIComponent(runRef.runId)}/cancel`);
    if (response.kind === 'uncertain') return { kind: 'uncertain' };
    if (response.status === 409 && typeof response.body?.phase === 'string') {
      const phase = response.body.phase;
      if (phase === 'queued' || phase === 'running' || phase === 'completed' || phase === 'failed' || phase === 'cancelled') {
        return { kind: 'already-terminal', phase };
      }
    }
    if (response.status >= 200 && response.status < 300) return { kind: 'cancelled' };
    return { kind: 'uncertain' };
  }

  async getArtifactsAndPullRequest(runRef: KatacodeRunRef): Promise<KatacodeArtifacts> {
    const response = await this.request('GET', `/v1/runs/${encodeURIComponent(runRef.runId)}/artifacts`);
    if (response.kind === 'uncertain' || response.status >= 400 || !response.body) {
      return { artifacts: [] };
    }
    return parseArtifacts(response.body);
  }

  async getDeepLink(runRef: KatacodeRunRef): Promise<KatacodeDeepLink> {
    const response = await this.request('GET', `/v1/runs/${encodeURIComponent(runRef.runId)}/link`);
    if (response.kind === 'ok' && typeof response.body?.url === 'string') return { url: response.body.url };
    return { url: `${this.endpoint}/runs/${encodeURIComponent(runRef.runId)}` };
  }

  private async request(
    method: string,
    path: string,
    options: { idempotencyKey?: string; body?: Record<string, unknown> } = {},
  ): Promise<{ kind: 'ok'; status: number; body?: Record<string, unknown>; error?: string } | { kind: 'uncertain' }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const credential = await this.getCredential();
      if (!credential) throw new Error('Katacode credential is not configured');
      const headers: Record<string, string> = {
        authorization: `Bearer ${credential}`,
        accept: 'application/json',
      };
      if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
      if (options.body) headers['content-type'] = 'application/json';
      const response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      let body: Record<string, unknown> | undefined;
      const text = await response.text();
      if (text) {
        try {
          body = JSON.parse(text) as Record<string, unknown>;
        } catch {
          body = undefined;
        }
      }
      return {
        kind: 'ok',
        status: response.status,
        body,
        error: typeof body?.error === 'string' ? body.error : undefined,
      };
    } catch {
      return { kind: 'uncertain' };
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseStatus(body: Record<string, unknown>): KatacodeProviderStatus {
  const phase = body.phase;
  if (phase === 'queued' || phase === 'running' || phase === 'completed' || phase === 'failed' || phase === 'cancelled') {
    return {
      phase,
      progressPercent: typeof body.progressPercent === 'number' && Number.isFinite(body.progressPercent)
        ? Math.max(0, Math.min(100, body.progressPercent))
        : undefined,
      tests: parseTests(body.tests),
      evidence: parseEvidence(body.evidence),
    };
  }
  return { phase: 'running' };
}

function parseTests(value: unknown): KatacodeProviderStatus['tests'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.passed !== 'number' || typeof record.failed !== 'number' || typeof record.total !== 'number'
    || !Number.isFinite(record.passed) || !Number.isFinite(record.failed) || !Number.isFinite(record.total)
  ) {
    return undefined;
  }
  return {
    passed: Math.max(0, Math.trunc(record.passed)),
    failed: Math.max(0, Math.trunc(record.failed)),
    total: Math.max(0, Math.trunc(record.total)),
  };
}

function parseEvidence(value: unknown): KatacodeEvidenceItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: KatacodeEvidenceItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.label !== 'string' || record.label.length === 0 || record.label.length > 200) continue;
    if (record.kind !== 'log' && record.kind !== 'artifact' && record.kind !== 'diff') continue;
    items.push({ label: record.label, kind: record.kind });
    if (items.length >= 32) break;
  }
  return items;
}

function parseArtifacts(body: Record<string, unknown>): KatacodeArtifacts {
  const pullRequest = body.pullRequest && typeof body.pullRequest === 'object' && !Array.isArray(body.pullRequest)
    ? body.pullRequest as Record<string, unknown>
    : null;
  const url = typeof pullRequest?.url === 'string' && /^https?:\/\//i.test(pullRequest.url)
    ? pullRequest.url
    : undefined;
  return {
    artifacts: parseEvidence(body.artifacts) ?? [],
    pullRequest: pullRequest && url && typeof pullRequest.title === 'string' && typeof pullRequest.number === 'number'
      ? {
        title: pullRequest.title.slice(0, 200),
        url,
        number: Math.trunc(pullRequest.number),
      }
      : undefined,
    diffSummary: typeof body.diffSummary === 'string' ? body.diffSummary.slice(0, 4_000) : undefined,
  };
}
