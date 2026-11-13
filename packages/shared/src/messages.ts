import { z } from 'zod';

export const emptyQuerySchema = z.strictObject({});

export const wsClientMessageSchema = z.strictObject({
  type: z.literal('ping'),
});

export const wsServerMessageSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('pong'),
    timestamp: z.string(),
  }),
  z.strictObject({
    type: z.literal('error'),
    code: z.literal('VALIDATION_ERROR'),
    message: z.string(),
  }),
]);

export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
