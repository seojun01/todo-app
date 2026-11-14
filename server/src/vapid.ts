// VAPID 키(RFC 8292): 서버가 푸시 서비스에 자기를 밝히는 P-256 키쌍. 첫 사용 때 만들어 파일(0600)에 저장하고 이후에는 읽어 쓴다.
// 키가 바뀌면 기존 구독이 무효가 되므로 파일을 지우거나 바꾸지 않는다 (바뀌면 클라이언트가 공개키 변화를 감지해 다시 구독한다).
import { createPrivateKey, generateKeyPairSync, type JsonWebKey, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface Vapid {
  /** 비압축 점(65바이트)의 base64url — 클라이언트의 applicationServerKey 와 VAPID `k` 값 */
  publicKey: string;
  privateKey: KeyObject;
}

const fromJwk = (jwk: JsonWebKey): Vapid => {
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('VAPID 키 파일 형식이 올바르지 않아요');
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  if (point.length !== 65) throw new Error('VAPID 공개키 길이가 올바르지 않아요');
  return { publicKey: point.toString('base64url'), privateKey: createPrivateKey({ key: jwk, format: 'jwk' }) };
};

/** file 이 있으면 읽고, 없으면 새로 만들어 0600 으로 저장한다 */
export function loadOrCreateVapid(file: string): Vapid {
  if (existsSync(file)) return fromJwk((JSON.parse(readFileSync(file, 'utf8')) as { privateJwk?: JsonWebKey }).privateJwk ?? {});
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  mkdirSync(dirname(file), { recursive: true, mode: 0o750 });
  writeFileSync(file, JSON.stringify({ privateJwk: jwk }, null, 2), { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600); // umask 와 관계없이
  return fromJwk(jwk);
}
