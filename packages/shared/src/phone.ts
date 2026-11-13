const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Structural E.164 normalisation.
 * Accepts an international number with a + or 00 prefix and returns +digits.
 * Does not guess a country calling code and does not consult a numbering plan.
 */
export function normalisePhone(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '' || /[A-Za-z]/.test(trimmed)) return null;
  let compact = trimmed.replace(/[\s().-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (!compact.startsWith('+')) return null;
  if (!E164.test(compact)) return null;
  return compact;
}
