import { createHash } from 'node:crypto';

import { canonicalDecimal, decimalGreaterThan, subtractDecimals } from '@k2/shared';
import type { Pool } from 'pg';

import { AppError } from '../../infrastructure/http/errors.js';
import type { ExecutableQuote, TradingOrderResult, TradingService } from './trading-service.js';
import { TradingConflictError } from './trading-service.js';

export type ClosePercent = 25 | 50 | 75 | 100;

/** Floor to the quantity scale. 100 percent keeps the exact remaining quantity. */
export function floorQuantityPercent(
  quantity: string,
  scale: number,
  percent: ClosePercent,
): string {
  const exact = canonicalDecimal(quantity, scale);
  if (percent === 100) return exact;
  const digits = exact.replace('.', '');
  const part = (BigInt(digits) * BigInt(percent)) / 100n;
  const text = part.toString().padStart(scale + 1, '0');
  if (scale === 0) return text;
  return `${text.slice(0, -scale)}.${text.slice(-scale)}`;
}

export async function closeByPercent(
  pool: Pool,
  trading: TradingService,
  input: {
    positionId: string;
    userId: string;
    percentage: ClosePercent;
    idempotencyKey: string;
    requestHash: string;
    quote: ExecutableQuote | null;
  },
): Promise<TradingOrderResult> {
  const prior = await readClose(pool, input.idempotencyKey);
  if (prior) {
    if (prior.user_id !== input.userId || prior.request_hash !== input.requestHash) {
      throw new TradingConflictError('This idempotency key was already used');
    }
    return prior.response;
  }
  const target = await closeQuantity(pool, input);
  if (!input.quote) {
    throw new AppError('VALIDATION_ERROR', 400, 'A quote is required to close a position');
  }
  const quote = input.quote;
  const result = await trading.submit({
    accountId: target.accountId,
    userId: input.userId,
    instrumentId: target.instrumentId,
    clientOrderId: `close-${createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24)}`,
    idempotencyKey: `close-order:${input.idempotencyKey}`,
    side: 'SELL',
    orderType: 'MARKET',
    quantity: target.quantity,
    limitPrice: null,
    quote,
  });
  try {
    await pool.query(
      `INSERT INTO trading_commands (idempotency_key, command_name, user_id, request_hash, response)
       VALUES ($1, 'positions.close', $2, $3, $4::jsonb)`,
      [input.idempotencyKey, input.userId, input.requestHash, JSON.stringify(result)],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const again = await readClose(pool, input.idempotencyKey);
    if (!again || again.user_id !== input.userId || again.request_hash !== input.requestHash) {
      throw new TradingConflictError('This idempotency key was already used');
    }
    return again.response;
  }
  return result;
}

async function closeQuantity(
  pool: Pool,
  input: { positionId: string; userId: string; percentage: ClosePercent },
): Promise<{ accountId: string; instrumentId: string; quantity: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const peek = await client.query<{ account_id: string }>(
      `SELECT p.account_id
         FROM positions p
         JOIN trading_accounts a ON a.id = p.account_id
        WHERE p.id = $1 AND a.user_id = $2`,
      [input.positionId, input.userId],
    );
    const accountId = peek.rows[0]?.account_id;
    if (!accountId) throw new AppError('NOT_FOUND', 404, 'Position not found');
    await client.query('SELECT id FROM trading_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const position = await client.query<{
      instrument_id: string;
      status: string;
      quantity: string;
      reserved_sell: string;
      quantity_scale: number;
    }>(
      `SELECT p.instrument_id, p.status, p.quantity::text, p.reserved_sell::text, i.quantity_scale
         FROM positions p
         JOIN instruments i ON i.id = p.instrument_id
        WHERE p.id = $1
        FOR UPDATE OF p`,
      [input.positionId],
    );
    const row = position.rows[0];
    if (!row || row.status !== 'OPEN') {
      throw new AppError('VALIDATION_ERROR', 400, 'Only an open position can be closed');
    }
    const free = subtractDecimals(row.quantity, row.reserved_sell, row.quantity_scale);
    const quantity = floorQuantityPercent(free, row.quantity_scale, input.percentage);
    if (!decimalGreaterThan(quantity, '0', row.quantity_scale)) {
      throw new AppError('VALIDATION_ERROR', 400, 'The close quantity rounds to zero');
    }
    await client.query('COMMIT');
    return { accountId, instrumentId: row.instrument_id, quantity };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function readClose(
  pool: Pool,
  key: string,
): Promise<{ user_id: string; request_hash: string; response: TradingOrderResult } | null> {
  const result = await pool.query<{
    user_id: string;
    request_hash: string;
    response: TradingOrderResult;
  }>('SELECT user_id, request_hash, response FROM trading_commands WHERE idempotency_key = $1', [
    key,
  ]);
  return result.rows[0] ?? null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === 'trading_commands_pkey'
  );
}
