import { expect, test } from '@playwright/test';

test('trading orders through the API proxy require a signed-in session', async ({ request }) => {
  const response = await request.post('/k2-api/trading/orders', {
    data: {
      accountId: '00000000-0000-4000-8000-000000000001',
      instrumentId: '00000000-0000-4000-8000-000000000002',
      clientOrderId: 'playwright',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: '1',
      limitPrice: null,
    },
    headers: {
      'x-k2-request': '1',
      'idempotency-key': 'playwright-trading-order',
    },
  });
  expect(response.status()).toBe(401);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code: 'AUTHENTICATION_FAILED' } });
});
