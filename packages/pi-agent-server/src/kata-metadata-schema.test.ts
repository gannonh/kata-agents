import { describe, expect, it } from 'bun:test';
import { createEditToolDefinition } from '@mariozechner/pi-coding-agent';
import { allowKataMetadataProperties, stripKataMetadata } from './kata-metadata-schema.ts';

describe('Craft metadata schema compatibility for Pi tools', () => {
  it('widens a strict Edit-like schema with optional Craft metadata properties', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
            required: ['oldText', 'newText'],
          },
        },
      },
      required: ['path', 'edits'],
    };

    const widened = allowKataMetadataProperties(schema);

    expect(widened).not.toBe(schema);
    expect(widened.additionalProperties).toBe(false);
    expect(widened.required).toEqual(schema.required);
    expect(widened.required).not.toContain('_displayName');
    expect(widened.required).not.toContain('_intent');
    expect(widened.properties._displayName).toBeDefined();
    expect(widened.properties._intent).toBeDefined();
    expect(widened.properties.path).toBe(schema.properties.path);
    expect(widened.properties.edits).toBe(schema.properties.edits);
  });

  it('widens the actual Pi Edit tool schema without making metadata required', () => {
    const editTool = createEditToolDefinition('/tmp');
    const widened = allowKataMetadataProperties(editTool.parameters);
    const widenedSchema = widened as {
      additionalProperties?: unknown;
      properties: Record<string, unknown>;
      required?: string[];
    };

    expect(widenedSchema.additionalProperties).toBe(false);
    expect(widenedSchema.properties._displayName).toBeDefined();
    expect(widenedSchema.properties._intent).toBeDefined();
    expect(widenedSchema.required ?? []).not.toContain('_displayName');
    expect(widenedSchema.required ?? []).not.toContain('_intent');
  });

  it('preserves upstream metadata properties if Pi defines them later', () => {
    const upstreamDisplayName = { type: 'string', description: 'upstream display name' };
    const upstreamIntent = { type: 'string', description: 'upstream intent' };
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        _displayName: upstreamDisplayName,
        _intent: upstreamIntent,
        path: { type: 'string' },
      },
      required: ['path'],
    };

    const widened = allowKataMetadataProperties(schema);

    expect(widened.properties._displayName).toBe(upstreamDisplayName);
    expect(widened.properties._intent).toBe(upstreamIntent);
  });

  it('returns unknown schema shapes unchanged', () => {
    expect(allowKataMetadataProperties(undefined)).toBeUndefined();
    expect(allowKataMetadataProperties('schema')).toBe('schema');

    const noProperties = { type: 'string' };
    expect(allowKataMetadataProperties(noProperties)).toBe(noProperties);
  });

  it('strips Craft metadata before upstream Pi tool execution', () => {
    const input = {
      _displayName: 'Edit Lines',
      _intent: 'Add punctuation',
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    };

    const clean = stripKataMetadata(input);

    expect(clean).toEqual({
      path: 'random',
      edits: [{ oldText: 'a', newText: 'b' }],
    });
    expect(clean).not.toHaveProperty('_displayName');
    expect(clean).not.toHaveProperty('_intent');
    expect(input).toHaveProperty('_displayName', 'Edit Lines');
    expect(input).toHaveProperty('_intent', 'Add punctuation');
  });

  it('returns the same input object when no metadata is present', () => {
    const input = { path: 'random' };
    expect(stripKataMetadata(input)).toBe(input);
  });
});
