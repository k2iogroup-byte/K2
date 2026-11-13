import { randomUUID } from 'node:crypto';

export function registrationBody(
  email: string,
  password = 'correct-horse-battery',
  username?: string,
): {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  password: string;
  country: string;
  city: string;
  streetAddress: string;
  postalCode: string;
  phone: string;
} {
  return {
    firstName: 'Ada',
    lastName: 'Trader',
    username: username ?? `ada${randomUUID().replace(/-/g, '')}`.slice(0, 32),
    email,
    password,
    country: 'United States',
    city: 'Chicago',
    streetAddress: '1 Market Street',
    postalCode: '60601',
    phone: '+1 (415) 555-2671',
  };
}
