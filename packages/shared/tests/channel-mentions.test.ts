import { describe, expect, it } from 'bun:test';
import { parseChannelMentions } from '../src/channels/mentions.ts';

const members = [
  { botId: 'bot-research', name: 'Research' },
  { botId: 'bot-research-long', name: 'Research Bot' },
  { botId: 'bot-release', name: 'Release Bot' },
];

describe('parseChannelMentions', () => {
  it('matches the longest member name case-insensitively', () => {
    expect(parseChannelMentions('@research bot please help', members)).toEqual({
      everyone: false,
      botIds: ['bot-research-long'],
      unresolved: [],
    });
  });

  it('recognizes everyone and preserves first-appearance order without duplicates', () => {
    expect(parseChannelMentions('@Release Bot @research @release bot @everyone @research', members)).toEqual({
      everyone: true,
      botIds: ['bot-release', 'bot-research'],
      unresolved: [],
    });
  });

  it('does not treat an email address as a mention', () => {
    expect(parseChannelMentions('send this to user@example.com', members)).toEqual({
      everyone: false,
      botIds: [],
      unresolved: [],
    });
  });

  it('captures unresolved mention tokens', () => {
    expect(parseChannelMentions('please ask @Unknown_Bot and @another.bot', members)).toEqual({
      everyone: false,
      botIds: [],
      unresolved: ['Unknown_Bot', 'another.bot'],
    });
  });

  it('treats @everyone as the reserved token even when a member is named everyone', () => {
    expect(parseChannelMentions('@everyone please help', [
      { botId: 'bot-everyone', name: 'everyone' },
      { botId: 'bot-research', name: 'Research' },
    ])).toEqual({
      everyone: true,
      botIds: [],
      unresolved: [],
    });
  });
});
