import { createHash } from 'node:crypto';

import {
  canonicalDecimal,
  DecimalError,
  decimalGreaterThan,
  decimalLessThan,
  decimalsEqual,
  subtractDecimals,
} from '@k2/shared';
import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../infrastructure/http/errors.js';
import type { ExecutableQuote, TradingService } from './trading-service.js';
import { TradingConflictError } from './trading-service.js';

export function protectionPricesValid(
  stopLoss: string | null,
  takeProfit: string | null,
  reference: string,
  scale: number,
): boolean {
  if (stopLoss && !decimalLessThan(stopLoss, reference, scale)) return false;
  if (takeProfit && !decimalGreaterThan(takeProfit, reference, scale)) return false;
  if (stopLoss && takeProfit && !decimalLessThan(stopLoss, takeProfit, scale)) return false;
  return true;
}

export function protectionHash(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export async function assertEntryProtection(
  pool: Pool,
  instrumentId: string,
  stopLoss: string | null,
  takeProfit: string | null,
  reference: string,
): Promise<void> {
  const scale = await priceScale(pool, instrumentId);
  let stop: string | null;
  let take: string | null;
  let ref: string;
  try {
    stop = stopLoss ? canonicalDecimal(stopLoss, scale) : null;
    take = takeProfit ? canonicalDecimal(takeProfit, scale) : null;
    ref = canonicalDecimal(reference, scale);
  } catch (error) {
    if (error instanceof DecimalError) {
      throw new AppError('VALIDATION_ERROR', 400, 'Protection prices must be decimal strings');
    }
    throw error;
  }
  if (!protectionPricesValid(stop, take, ref, scale)) {
    throw new AppError(
      'PROTECTION_PRICE_INVALID',
      400,
      'Stop loss must be below the entry reference and take profit above it',
    );
  }
}

export async function saveEntryProtection(
  pool: Pool,
  input: {
    accountId: string;
    userId: string;
    instrumentId: string;
    clientOrderId: string;
    stopLoss: string | null;
    takeProfit: string | null;
  },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM trading_accounts WHERE id = $1 FOR UPDATE', [
      input.accountId,
    ]);
    const scale = await priceScale(client, input.instrumentId);
    await cancelUnattached(client, input.accountId, input.clientOrderId);
    if (input.stopLoss) {
      await insertProtection(client, input, 'STOP_LOSS', canonicalDecimal(input.stopLoss, scale));
    }
    if (input.takeProfit) {
      await insertProtection(
        client,
        input,
        'TAKE_PROFIT',
        canonicalDecimal(input.takeProfit, scale),
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelEntryProtection(
  pool: Pool,
  accountId: string,
  clientOrderId: string,
): Promise<void> {
  await pool.query(
    `UPDATE conditional_orders
        SET state = 'CANCELLED', updated_at = now()
      WHERE account_id = $1 AND client_order_id = $2 AND position_id IS NULL
        AND state = 'PENDING' AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')`,
    [accountId, clientOrderId],
  );
}

export async function attachFilledProtection(
  pool: Pool,
  accountId: string,
  instrumentId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM trading_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const position = await client.query<{ id: string }>(
      `SELECT id FROM positions
        WHERE account_id = $1 AND instrument_id = $2 AND status = 'OPEN' AND quantity > 0
        FOR UPDATE`,
      [accountId, instrumentId],
    );
    const open = position.rows[0];
    if (!open) {
      await client.query('COMMIT');
      return;
    }
    const pending = await client.query<{ id: string; kind: string; trigger_price: string }>(
      `SELECT id, kind, trigger_price::text
         FROM conditional_orders
        WHERE account_id = $1 AND instrument_id = $2 AND position_id IS NULL
          AND state = 'PENDING' AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')
          AND (
            EXISTS (
              SELECT 1 FROM orders
               WHERE orders.account_id = conditional_orders.account_id
                 AND orders.client_order_id = conditional_orders.client_order_id
                 AND orders.filled_quantity > 0
            )
            OR EXISTS (
              SELECT 1 FROM conditional_orders AS entry
              JOIN orders ON orders.id = entry.resulting_order_id
               WHERE entry.account_id = conditional_orders.account_id
                 AND entry.client_order_id = conditional_orders.client_order_id
                 AND entry.kind = 'ENTRY_STOP' AND entry.state = 'TRIGGERED'
                 AND orders.filled_quantity > 0
            )
          )
        FOR UPDATE`,
      [accountId, instrumentId],
    );
    if (pending.rows.length === 0) {
      await client.query('COMMIT');
      return;
    }
    let stop: string | null = null;
    let take: string | null = null;
    for (const row of pending.rows) {
      if (row.kind === 'STOP_LOSS') stop = row.trigger_price;
      if (row.kind === 'TAKE_PROFIT') take = row.trigger_price;
    }
    await client.query(
      `INSERT INTO position_protection (position_id, stop_loss_price, take_profit_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (position_id) DO UPDATE
         SET stop_loss_price = COALESCE(EXCLUDED.stop_loss_price, position_protection.stop_loss_price),
             take_profit_price = COALESCE(EXCLUDED.take_profit_price, position_protection.take_profit_price),
             version = position_protection.version + 1,
             updated_at = now()`,
      [open.id, stop, take],
    );
    await client.query(
      `UPDATE conditional_orders SET position_id = $2, updated_at = now() WHERE id = ANY($1::uuid[])`,
      [pending.rows.map((row) => row.id), open.id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function attachInstrumentProtection(pool: Pool, instrumentId: string): Promise<void> {
  const accounts = await pool.query<{ account_id: string }>(
    `SELECT DISTINCT account_id FROM conditional_orders
      WHERE instrument_id = $1 AND position_id IS NULL AND state = 'PENDING'
        AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')`,
    [instrumentId],
  );
  for (const row of accounts.rows) {
    await attachFilledProtection(pool, row.account_id, instrumentId);
  }
}

export type ProtectionView = {
  positionId: string;
  version: number;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
};

export async function patchProtection(
  pool: Pool,
  input: {
    positionId: string;
    userId: string;
    version: number;
    stopLoss: string | null;
    takeProfit: string | null;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<ProtectionView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const prior = await readCommand(client, input.idempotencyKey);
    if (prior) {
      await client.query('ROLLBACK');
      if (prior.user_id !== input.userId || prior.request_hash !== input.requestHash) {
        throw new TradingConflictError('This idempotency key was already used');
      }
      return prior.response;
    }
    const position = await client.query<{
      id: string;
      account_id: string;
      instrument_id: string;
      status: string;
      price_scale: number;
    }>(
      `SELECT p.id, p.account_id, p.instrument_id, p.status, i.price_scale
         FROM positions p
         JOIN trading_accounts a ON a.id = p.account_id
         JOIN instruments i ON i.id = p.instrument_id
        WHERE p.id = $1 AND a.user_id = $2
        FOR UPDATE OF p`,
      [input.positionId, input.userId],
    );
    const row = position.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      throw new AppError('NOT_FOUND', 404, 'Position not found');
    }
    if (row.status !== 'OPEN') {
      await client.query('ROLLBACK');
      throw new AppError('VALIDATION_ERROR', 400, 'Protection applies to an open position');
    }
    const bid = await client.query<{ bid: string }>(
      `SELECT bid::text AS bid FROM quote_snapshots WHERE instrument_id = $1`,
      [row.instrument_id],
    );
    const reference = bid.rows[0]?.bid;
    if (!reference && (input.stopLoss || input.takeProfit)) {
      await client.query('ROLLBACK');
      throw new AppError('VALIDATION_ERROR', 400, 'A quote is required to check protection prices');
    }
    let stop: string | null;
    let take: string | null;
    try {
      stop = input.stopLoss ? canonicalDecimal(input.stopLoss, row.price_scale) : null;
      take = input.takeProfit ? canonicalDecimal(input.takeProfit, row.price_scale) : null;
    } catch (error) {
      if (error instanceof DecimalError) {
        throw new AppError('VALIDATION_ERROR', 400, 'Protection prices must be decimal strings');
      }
      throw error;
    }
    if (
      reference &&
      (stop || take) &&
      !protectionPricesValid(
        stop,
        take,
        canonicalDecimal(reference, row.price_scale),
        row.price_scale,
      )
    ) {
      await client.query('ROLLBACK');
      throw new AppError(
        'PROTECTION_PRICE_INVALID',
        400,
        'Stop loss must be below the bid and take profit above it',
      );
    }
    const current = await client.query<{ version: string }>(
      `SELECT version::text FROM position_protection WHERE position_id = $1 FOR UPDATE`,
      [row.id],
    );
    const existing = current.rows[0];
    if (existing) {
      if (Number(existing.version) !== input.version) {
        await client.query('ROLLBACK');
        throw new AppError('CONFLICT', 409, 'Position protection version does not match');
      }
      await client.query(
        `UPDATE position_protection
            SET stop_loss_price = $2, take_profit_price = $3, version = version + 1, updated_at = now()
          WHERE position_id = $1`,
        [row.id, stop, take],
      );
    } else if (input.version !== 0) {
      await client.query('ROLLBACK');
      throw new AppError('CONFLICT', 409, 'Position protection version does not match');
    } else {
      await client.query(
        `INSERT INTO position_protection (position_id, stop_loss_price, take_profit_price)
         VALUES ($1, $2, $3)`,
        [row.id, stop, take],
      );
    }
    await client.query(
      `UPDATE conditional_orders SET state = 'CANCELLED', updated_at = now()
        WHERE position_id = $1 AND state = 'PENDING' AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')`,
      [row.id],
    );
    if (stop) await insertBound(client, row, input.userId, 'STOP_LOSS', stop);
    if (take) await insertBound(client, row, input.userId, 'TAKE_PROFIT', take);
    const saved = await client.query<{
      version: string;
      stop_loss_price: string | null;
      take_profit_price: string | null;
    }>(
      `SELECT version::text, stop_loss_price::text, take_profit_price::text
         FROM position_protection WHERE position_id = $1`,
      [row.id],
    );
    const body: ProtectionView = {
      positionId: row.id,
      version: Number(saved.rows[0]?.version ?? 1),
      stopLossPrice: saved.rows[0]?.stop_loss_price ?? null,
      takeProfitPrice: saved.rows[0]?.take_profit_price ?? null,
    };
    await client.query(
      `INSERT INTO trading_commands (idempotency_key, command_name, user_id, request_hash, response)
       VALUES ($1, 'positions.protect', $2, $3, $4::jsonb)`,
      [input.idempotencyKey, input.userId, input.requestHash, JSON.stringify(body)],
    );
    await client.query('COMMIT');
    return body;
  } catch (error) {
    await client.query('ROLLBACK');
    if (isUniqueViolation(error)) {
      const prior = await readCommand(pool, input.idempotencyKey);
      if (!prior || prior.user_id !== input.userId || prior.request_hash !== input.requestHash) {
        throw new TradingConflictError('This idempotency key was already used');
      }
      return prior.response;
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function fireProtection(
  pool: Pool,
  trading: TradingService,
  instrumentId: string,
  quote: ExecutableQuote,
): Promise<void> {
  const pending = await pool.query<{ id: string }>(
    `SELECT id FROM conditional_orders
      WHERE instrument_id = $1 AND state = 'PENDING' AND position_id IS NOT NULL
        AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')
      ORDER BY created_at`,
    [instrumentId],
  );
  for (const row of pending.rows) {
    await fireOneProtection(pool, trading, row.id, quote);
  }
}

async function fireOneProtection(
  pool: Pool,
  trading: TradingService,
  id: string,
  quote: ExecutableQuote,
): Promise<void> {
  const claimed = await claimProtection(pool, id, quote);
  if (!claimed) return;
  let result = await trading.submit({
    accountId: claimed.accountId,
    userId: claimed.userId,
    instrumentId: claimed.instrumentId,
    clientOrderId: `protect-${id}`,
    idempotencyKey: `protect:${id}:${quote.quoteUpdateId}`,
    side: 'SELL',
    orderType: 'MARKET',
    quantity: claimed.quantity,
    limitPrice: null,
    quote,
  });
  if (result.rejectReason === 'INSUFFICIENT_POSITION') {
    const free = await freeQuantity(pool, claimed.positionId, claimed.quantityScale);
    if (free && decimalGreaterThan(free, '0', claimed.quantityScale) && free !== claimed.quantity) {
      result = await trading.submit({
        accountId: claimed.accountId,
        userId: claimed.userId,
        instrumentId: claimed.instrumentId,
        clientOrderId: `protect-${id}-rest`,
        idempotencyKey: `protect:${id}:${quote.quoteUpdateId}:rest`,
        side: 'SELL',
        orderType: 'MARKET',
        quantity: free,
        limitPrice: null,
        quote,
      });
    }
  }
  if (
    result.state === 'REJECTED' &&
    decimalsEqual(result.filledQuantity, '0', claimed.quantityScale)
  ) {
    await restoreProtection(pool, id, claimed.siblingIds);
    return;
  }
  await pool.query(
    `UPDATE conditional_orders SET resulting_order_id = $2, updated_at = now() WHERE id = $1`,
    [id, result.orderId],
  );
}

type Claim = {
  accountId: string;
  userId: string;
  instrumentId: string;
  positionId: string;
  quantity: string;
  quantityScale: number;
  siblingIds: string[];
};

async function claimProtection(
  pool: Pool,
  id: string,
  quote: ExecutableQuote,
): Promise<Claim | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const peek = await client.query<{ account_id: string }>(
      `SELECT account_id FROM conditional_orders WHERE id = $1`,
      [id],
    );
    const accountId = peek.rows[0]?.account_id;
    if (!accountId) {
      await client.query('COMMIT');
      return null;
    }
    await client.query('SELECT id FROM trading_accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const locked = await client.query<{
      kind: string;
      trigger_price: string;
      user_id: string;
      instrument_id: string;
      position_id: string;
      state: string;
      price_scale: number;
      quantity_scale: number;
    }>(
      `SELECT conditional_orders.kind, conditional_orders.trigger_price::text,
              conditional_orders.user_id, conditional_orders.instrument_id,
              conditional_orders.position_id, conditional_orders.state,
              instruments.price_scale, instruments.quantity_scale
         FROM conditional_orders
         JOIN instruments ON instruments.id = conditional_orders.instrument_id
        WHERE conditional_orders.id = $1
        FOR UPDATE OF conditional_orders`,
      [id],
    );
    const stop = locked.rows[0];
    if (!stop || stop.state !== 'PENDING' || !stop.position_id) {
      await client.query('COMMIT');
      return null;
    }
    const position = await client.query<{ quantity: string; reserved_sell: string }>(
      `SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1 FOR UPDATE`,
      [stop.position_id],
    );
    const held = position.rows[0];
    const bid = canonicalDecimal(quote.bid, stop.price_scale);
    const trigger = canonicalDecimal(stop.trigger_price, stop.price_scale);
    const crossed =
      stop.kind === 'STOP_LOSS'
        ? !decimalGreaterThan(bid, trigger, stop.price_scale)
        : !decimalLessThan(bid, trigger, stop.price_scale);
    if (!held || !crossed) {
      await client.query('COMMIT');
      return null;
    }
    const free = subtractDecimals(held.quantity, held.reserved_sell, stop.quantity_scale);
    if (!decimalGreaterThan(free, '0', stop.quantity_scale)) {
      await client.query(
        `UPDATE conditional_orders SET state = 'CANCELLED', updated_at = now() WHERE id = $1`,
        [id],
      );
      await client.query('COMMIT');
      return null;
    }
    const siblings = await client.query<{ id: string }>(
      `SELECT id FROM conditional_orders
        WHERE position_id = $1 AND id <> $2 AND state = 'PENDING'
          AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')
        FOR UPDATE`,
      [stop.position_id, id],
    );
    await client.query(
      `UPDATE conditional_orders SET state = 'TRIGGERED', updated_at = now() WHERE id = $1`,
      [id],
    );
    if (siblings.rows.length > 0) {
      await client.query(
        `UPDATE conditional_orders SET state = 'CANCELLED', updated_at = now() WHERE id = ANY($1::uuid[])`,
        [siblings.rows.map((row) => row.id)],
      );
    }
    await client.query('COMMIT');
    return {
      accountId,
      userId: stop.user_id,
      instrumentId: stop.instrument_id,
      positionId: stop.position_id,
      quantity: free,
      quantityScale: stop.quantity_scale,
      siblingIds: siblings.rows.map((row) => row.id),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function restoreProtection(pool: Pool, id: string, siblingIds: string[]): Promise<void> {
  await pool.query(
    `UPDATE conditional_orders SET state = 'PENDING', updated_at = now()
      WHERE id = $1 AND state = 'TRIGGERED' AND resulting_order_id IS NULL`,
    [id],
  );
  if (siblingIds.length === 0) return;
  await pool.query(
    `UPDATE conditional_orders SET state = 'PENDING', updated_at = now()
      WHERE id = ANY($1::uuid[]) AND state = 'CANCELLED' AND resulting_order_id IS NULL`,
    [siblingIds],
  );
}

async function freeQuantity(pool: Pool, positionId: string, scale: number): Promise<string | null> {
  const row = await pool.query<{ quantity: string; reserved_sell: string }>(
    `SELECT quantity::text, reserved_sell::text FROM positions WHERE id = $1`,
    [positionId],
  );
  const held = row.rows[0];
  if (!held) return null;
  return subtractDecimals(held.quantity, held.reserved_sell, scale);
}

async function priceScale(db: Pool | PoolClient, instrumentId: string): Promise<number> {
  const row = await db.query<{ price_scale: number }>(
    'SELECT price_scale FROM instruments WHERE id = $1',
    [instrumentId],
  );
  const scale = row.rows[0]?.price_scale;
  if (scale === undefined) throw new AppError('NOT_FOUND', 404, 'Instrument not found');
  return scale;
}

async function cancelUnattached(
  client: PoolClient,
  accountId: string,
  clientOrderId: string,
): Promise<void> {
  await client.query(
    `UPDATE conditional_orders SET state = 'CANCELLED', updated_at = now()
      WHERE account_id = $1 AND client_order_id = $2 AND position_id IS NULL AND state = 'PENDING'
        AND kind IN ('STOP_LOSS', 'TAKE_PROFIT')`,
    [accountId, clientOrderId],
  );
}

async function insertProtection(
  client: PoolClient,
  input: { accountId: string; userId: string; instrumentId: string; clientOrderId: string },
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
  price: string,
): Promise<void> {
  await client.query(
    `INSERT INTO conditional_orders (
       account_id, user_id, instrument_id, kind, side, trigger_price, state, client_order_id
     ) VALUES ($1, $2, $3, $4, 'SELL', $5, 'PENDING', $6)`,
    [input.accountId, input.userId, input.instrumentId, kind, price, input.clientOrderId],
  );
}

async function insertBound(
  client: PoolClient,
  row: { account_id: string; instrument_id: string; id: string },
  userId: string,
  kind: 'STOP_LOSS' | 'TAKE_PROFIT',
  price: string,
): Promise<void> {
  await client.query(
    `INSERT INTO conditional_orders (
       account_id, user_id, instrument_id, position_id, kind, side, trigger_price, state
     ) VALUES ($1, $2, $3, $4, $5, 'SELL', $6, 'PENDING')`,
    [row.account_id, userId, row.instrument_id, row.id, kind, price],
  );
}

async function readCommand(
  db: Pool | PoolClient,
  key: string,
): Promise<{ user_id: string; request_hash: string; response: ProtectionView } | null> {
  const result = await db.query<{
    user_id: string;
    request_hash: string;
    response: ProtectionView;
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
