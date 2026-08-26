import type { MemberAvailability } from '@kata-sh/core';

export interface ClaimRequest {
  readonly channelId: string;
  readonly channelName: string;
  readonly routeId: string;
  readonly botId: string;
  readonly botName: string;
  readonly profile?: string;
  readonly availability: MemberAvailability;
  readonly message: string;
}

export type ClaimEvaluator = (request: ClaimRequest, signal: AbortSignal) => Promise<string | null>;

export function buildClaimPrompt(request: ClaimRequest): string {
  return [
    'You are only a routing evaluator. Do not answer, execute, or act on the message.',
    'You have no tools, no memory, and no transcript for this routing decision.',
    `Your Bot name is: ${request.botName}`,
    `Your declared capabilities profile is: ${request.profile?.trim() || '(none declared)'}`,
    `Your current availability is: ${request.availability}`,
    `Channel: ${request.channelName} (${request.channelId})`,
    `Inbound message: ${request.message}`,
    'Decide whether you should own one response stage based only on your declared capabilities and availability.',
    'Respond with ONLY one JSON object matching exactly this shape: {"claim": boolean, "confidence": number, "reason": string}.',
    'confidence must be a number from 0 through 100. Do not include markdown or prose outside the JSON object.',
  ].join('\n');
}

export function parseClaimResponse(raw: string | null): { claim: boolean; confidence: number; reason: string } | null {
  if (raw === null) return null;
  let json = raw.trim();
  if (json.startsWith('```')) {
    const match = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (!match) return null;
    json = (match[1] ?? '').trim();
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (typeof value.claim !== 'boolean') return null;
    if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 100) return null;
    if (typeof value.reason !== 'string') return null;
    return { claim: value.claim, confidence: value.confidence, reason: value.reason };
  } catch {
    return null;
  }
}
