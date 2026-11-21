import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';

import { AppError } from '../../infrastructure/http/errors.js';
import { parseWithSchema } from '../../infrastructure/http/validation.js';
import type { AuthService } from '../auth/auth-service.js';
import { PERMISSIONS, requirePermission, requireVerifiedEmail } from '../auth/rbac.js';
import { noStore, requireWrite } from '../auth/request-context.js';
import type { MarketDataEngine } from './engine.js';

const bodySchema = z.strictObject({
  providerSymbol: z.string().min(1).max(32),
  bid: z.string().min(1).max(32),
  ask: z.string().min(1).max(32),
  quoteUpdateId: z.string().regex(/^[0-9]+$/),
});

/** Development-only way for a signed-in test to push one fixture quote into the engine. */
export function registerFixtureQuoteRoute(
  app: FastifyInstance,
  auth: AuthService,
  engine: MarketDataEngine,
  pool: Pool,
): void {
  app.post('/internal/test-fixture/quotes', async (request, reply) => {
    noStore(reply);
    const session = await requireWrite(auth, request);
    requireVerifiedEmail(session);
    requirePermission(session, PERMISSIONS.tradingExecute);
    const body = parseWithSchema(bodySchema, request.body);
    const instrument = await pool.query<{
      id: string;
      market: 'EQUITIES' | 'CRYPTO';
      venue: 'NASDAQ' | 'NYSE' | 'BINANCE_SPOT';
      symbol: string;
      provider_symbol: string;
      price_scale: number;
      quantity_scale: number;
    }>(
      `SELECT id, market, venue, symbol, provider_symbol, price_scale, quantity_scale
         FROM instruments WHERE lower(provider_symbol) = lower($1)`,
      [body.providerSymbol],
    );
    const row = instrument.rows[0];
    if (!row) throw new AppError('NOT_FOUND', 404, 'Instrument not found');
    engine.register({
      id: row.id,
      market: row.market,
      venue: row.venue,
      symbol: row.symbol,
      providerSymbol: row.provider_symbol,
      priceScale: row.price_scale,
      quantityScale: row.quantity_scale,
    });
    const receivedAt = new Date();
    const result = await engine.ingest(
      {
        kind: 'quote',
        providerEventId: `fixture-${body.quoteUpdateId}-${receivedAt.getTime()}`,
        providerSymbol: body.providerSymbol,
        bid: body.bid,
        ask: body.ask,
        bidSize: '8',
        askSize: '8',
        last: null,
        sourceTimestamp: receivedAt.toISOString(),
        sequence: Number(body.quoteUpdateId),
        quoteUpdateId: body.quoteUpdateId,
      },
      receivedAt,
    );
    if (result.status !== 'accepted') {
      throw new AppError('VALIDATION_ERROR', 400, 'Fixture quote was not accepted');
    }
    return reply.status(202).send({ status: 'accepted' });
  });
}
