export const EVERYONE_MENTION = 'everyone';

export interface ChannelMentionTarget {
  readonly botId: string;
  readonly name: string;
}

export interface ParsedChannelMentions {
  readonly everyone: boolean;
  readonly botIds: readonly string[];
  readonly unresolved: readonly string[];
}

const TOKEN = /[A-Za-z0-9_.-]/;

function isBoundary(value: string | undefined): boolean {
  return value === undefined || !TOKEN.test(value);
}

export function parseChannelMentions(
  text: string,
  members: readonly ChannelMentionTarget[],
): ParsedChannelMentions {
  const normalized = members
    .map((member) => ({ ...member, normalizedName: member.name.trim().toLocaleLowerCase() }))
    .filter((member) => member.normalizedName.length > 0)
    .sort((left, right) => right.normalizedName.length - left.normalizedName.length);
  const botIds: string[] = [];
  const botIdSet = new Set<string>();
  const unresolved: string[] = [];
  const unresolvedSet = new Set<string>();
  let everyone = false;

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@' || (index > 0 && !/\s/.test(text[index - 1] ?? ''))) continue;

    const remainder = text.slice(index + 1);
    const lowerRemainder = remainder.toLocaleLowerCase();

    // Reserved @everyone wins over a member whose display name is "everyone".
    if (
      lowerRemainder.startsWith(EVERYONE_MENTION)
      && isBoundary(remainder[EVERYONE_MENTION.length])
    ) {
      everyone = true;
      index += EVERYONE_MENTION.length;
      continue;
    }

    const matched = normalized.find((member) => {
      if (!lowerRemainder.startsWith(member.normalizedName)) return false;
      return isBoundary(remainder[member.normalizedName.length]);
    });
    if (matched) {
      if (!botIdSet.has(matched.botId)) {
        botIdSet.add(matched.botId);
        botIds.push(matched.botId);
      }
      index += matched.normalizedName.length;
      continue;
    }

    const tokenMatch = remainder.match(/^[A-Za-z0-9_.-]+/);
    if (!tokenMatch) continue;
    const token = tokenMatch[0];
    if (!unresolvedSet.has(token)) {
      unresolvedSet.add(token);
      unresolved.push(token);
    }
    index += token.length;
  }

  return { everyone, botIds, unresolved };
}

