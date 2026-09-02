import {
  KATACODE_ADAPTER_CONTRACT_VERSION,
  type KatacodeAdapter,
  type KatacodeArtifacts,
  type KatacodeCancelResult,
  type KatacodeDeepLink,
  type KatacodeDispatchAcceptance,
  type KatacodeDispatchRequest,
  type KatacodeLookupResult,
  type KatacodeProviderStatus,
  type KatacodeRunRef,
  type KatacodeStatusResult,
} from '@kata-sh/core';

export interface MemoryKatacodeRun {
  readonly idempotencyKey: string;
  status: KatacodeProviderStatus;
  resultMarkdown?: string;
  failureMessage?: string;
  artifacts: KatacodeArtifacts;
  cancelled: boolean;
}

export class MemoryKatacodeAdapter implements KatacodeAdapter {
  readonly contractVersion = KATACODE_ADAPTER_CONTRACT_VERSION;
  readonly dispatches: KatacodeDispatchRequest[] = [];
  nextAcceptance: KatacodeDispatchAcceptance | 'throw' = {
    kind: 'accepted',
    runRef: { runId: 'run_memory_1' },
  };
  nextLookup: KatacodeLookupResult | null = null;
  private readonly runs = new Map<string, MemoryKatacodeRun>();
  private readonly byKey = new Map<string, string>();
  private seq = 1;

  async dispatch(input: KatacodeDispatchRequest): Promise<KatacodeDispatchAcceptance> {
    this.dispatches.push(input);
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return { kind: 'accepted', runRef: { runId: existing } };
    if (this.nextAcceptance === 'throw') throw new Error('simulated disconnect');
    if (this.nextAcceptance.kind !== 'accepted') return this.nextAcceptance;
    const runId = this.nextAcceptance.runRef.runId === 'run_memory_1'
      ? `run_memory_${this.seq++}`
      : this.nextAcceptance.runRef.runId;
    this.byKey.set(input.idempotencyKey, runId);
    this.runs.set(runId, {
      idempotencyKey: input.idempotencyKey,
      status: { phase: 'running', progressPercent: 10 },
      artifacts: { artifacts: [] },
      cancelled: false,
    });
    return { kind: 'accepted', runRef: { runId } };
  }

  async lookupByIdempotencyKey(key: string): Promise<KatacodeLookupResult> {
    if (this.nextLookup) return this.nextLookup;
    const runId = this.byKey.get(key);
    if (!runId) return { kind: 'absent' };
    const run = this.runs.get(runId);
    if (!run) return { kind: 'absent' };
    return { kind: 'found', runRef: { runId }, status: run.status };
  }

  async getStatusAndResult(runRef: KatacodeRunRef): Promise<KatacodeStatusResult> {
    const run = this.runs.get(runRef.runId);
    if (!run) return { status: { phase: 'failed' }, failureMessage: 'unknown run' };
    return {
      status: run.status,
      resultMarkdown: run.resultMarkdown,
      failureMessage: run.failureMessage,
    };
  }

  async cancel(runRef: KatacodeRunRef): Promise<KatacodeCancelResult> {
    const run = this.runs.get(runRef.runId);
    if (!run) return { kind: 'uncertain' };
    if (run.status.phase === 'completed' || run.status.phase === 'failed' || run.status.phase === 'cancelled') {
      return { kind: 'already-terminal', phase: run.status.phase };
    }
    run.cancelled = true;
    run.status = { phase: 'cancelled' };
    return { kind: 'cancelled' };
  }

  async getArtifactsAndPullRequest(runRef: KatacodeRunRef): Promise<KatacodeArtifacts> {
    return this.runs.get(runRef.runId)?.artifacts ?? { artifacts: [] };
  }

  async getDeepLink(runRef: KatacodeRunRef): Promise<KatacodeDeepLink> {
    return { url: `https://katacode.example/runs/${runRef.runId}` };
  }

  fail(runId: string, failureMessage: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = { phase: 'failed', progressPercent: 100 };
    run.failureMessage = failureMessage;
  }

  complete(runId: string, resultMarkdown?: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = {
      phase: 'completed',
      progressPercent: 100,
      tests: { passed: 1, failed: 0, total: 1 },
      evidence: [{ label: 'unit', kind: 'log' }],
    };
    if (resultMarkdown !== undefined) run.resultMarkdown = resultMarkdown;
    run.artifacts = {
      artifacts: [{ label: 'coverage', kind: 'artifact' }],
      pullRequest: { title: 'Fix', url: 'https://github.com/example/repo/pull/1', number: 1 },
      diffSummary: '1 file changed',
    };
  }
}
