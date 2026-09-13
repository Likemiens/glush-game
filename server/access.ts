import { hashKey } from '../src/net/protocol';

export const TEST_HEADER = 'X-Glush-Test-Key';
export const TEST_PROTOCOL = 'glush-test.';
export const ACCESS_ERROR = 'Кооператив доступен только по закрытому приглашению на тест.';

export function accessKey(headers: Headers): string {
  const header = headers.get(TEST_HEADER);
  if (header !== null) return header;
  return (headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map(p => p.trim())
    .find(p => p.startsWith(TEST_PROTOCOL))?.slice(TEST_PROTOCOL.length) ?? '';
}

/** Called before looking up a room or its rate-limit Durable Object. Missing configuration locks the Worker. */
export async function hasTestAccess(headers: Headers, expectedHash?: string, required = true): Promise<boolean> {
  if (!expectedHash) return !required;
  const key = accessKey(headers);
  if (!/^[a-f0-9]{64}$/.test(key) || !/^[a-f0-9]{64}$/.test(expectedHash)) return false;
  const actual = await hashKey(key);
  let mismatch = 0;
  for (let i = 0; i < 64; i++) mismatch |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i);
  return mismatch === 0;
}
