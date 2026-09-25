import { z } from 'zod';

export const id = z.string().min(1).max(255);
export const sessionId = z.string().min(1).max(64).regex(/^[A-Za-z0-9-]+$/);
export const ownerId = sessionId.describe('Stable application user identifier. Reuse it across conversations.');
export const timestamp = z.iso.datetime({ offset: true });
export const text = z.string().min(1).max(50_000);
export const topics = z.array(z.string().min(1).max(100)).max(50);
export const namespaceRef = z.object({ namespaceId: id });
export const placement = { namespace: z.string().max(255).optional(), namespaceRef: namespaceRef.optional() };
export const page = { limit: z.number().int().min(1).max(100).optional(), pageToken: z.string().optional() };
export const event = z.object({
  sessionId: sessionId.optional().describe('Reuse the current session ID. Omit only to create a new session.'),
  actorId: id.describe('Author of this event: user ID for USER, agent ID for ASSISTANT.'),
  role: z.enum(['USER', 'ASSISTANT', 'SYSTEM']),
  content: z.array(z.object({ text })).min(1),
  createdAt: timestamp.optional().describe('ISO 8601 timestamp; defaults to the current time.'),
  metadata: z.unknown().optional().describe('Optional JSON metadata attached to the event.'),
  ...placement,
});
export const memory = z.object({
  id: id.describe('Stable unique memory ID. Reuse this ID if retrying the same creation.'),
  text,
  ownerId: ownerId.optional().describe('Required unless the toolset has a fixed ownerId.'),
  sessionId: sessionId.optional(),
  memoryType: z.string().min(1).optional().describe('Built-in or registered custom memory type.'),
  topics: topics.optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  ...placement,
});
export const memoryUpdate = z.object({
  text: text.optional(), memoryType: z.string().min(1).optional(), topics: topics.optional(),
  ownerId: ownerId.optional(), sessionId: z.union([sessionId, z.literal('')]).optional(), ...placement,
});
const comparison = z.object({
  eq: z.string().optional(), ne: z.string().optional(),
  in: z.array(z.string()).min(1).optional(), all: z.array(z.string()).min(1).optional(),
}).refine(value => Object.values(value).filter(v => v !== undefined).length === 1,
  'Supply exactly one of eq, ne, in, all.');
export const search = z.object({
  text: text.optional(), similarityThreshold: z.number().min(0).max(1).optional(), ...page,
  filterOp: z.enum(['all', 'any']).optional(),
  filter: z.object({
    sessionId: comparison.optional(), ownerId: comparison.optional(), namespace: comparison.optional(),
    topics: comparison.optional(), memoryType: comparison.optional(),
    namespaceRef: z.object({ eq: id.optional(), in: z.array(id).min(1).optional() })
      .refine(v => (v.eq === undefined) !== (v.in === undefined), 'Supply exactly one of eq or in.').optional(),
    unnamespaced: z.boolean().optional(),
    createdAt: z.object({ gt: timestamp.optional(), gte: timestamp.optional(), lt: timestamp.optional(),
      lte: timestamp.optional(), eq: timestamp.optional() }).optional(),
    attributes: z.record(z.string(), z.union([
      z.object({ string: z.string() }).strict(), z.object({ number: z.number() }).strict(),
      z.object({ boolean: z.boolean() }).strict(), z.object({ list: z.array(z.string()) }).strict(),
    ])).optional(),
  }).optional(),
});
