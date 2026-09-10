import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RoomTokenClaims } from './types.js';

export function verifyRoomToken(token: string, secret: string): RoomTokenClaims | null {
    const segments = token.split('.');
    if (segments.length !== 3 || secret.length < 32) return null;
    const [encoded_header, encoded_payload, encoded_signature] = segments;
    if (!encoded_header || !encoded_payload || !encoded_signature) return null;
    const unsigned_token = `${encoded_header}.${encoded_payload}`;
    const expected_signature = createHmac('sha256', secret).update(unsigned_token).digest();
    let supplied_signature: Buffer;
    try {
        supplied_signature = Buffer.from(encoded_signature, 'base64url');
    } catch {
        return null;
    }
    if (supplied_signature.length !== expected_signature.length
        || !timingSafeEqual(supplied_signature, expected_signature)) return null;

    try {
        const header = JSON.parse(Buffer.from(encoded_header, 'base64url').toString('utf8')) as Record<string, unknown>;
        const claims = JSON.parse(Buffer.from(encoded_payload, 'base64url').toString('utf8')) as RoomTokenClaims;
        const now = Math.floor(Date.now() / 1000);
        if (header.algorithm !== 'HS256'
            || header.type !== 'JWT'
            || claims.protocol_version !== 2
            || !Number.isInteger(claims.issued_at)
            || !Number.isInteger(claims.expires_at)
            || claims.issued_at > now + 60
            || claims.expires_at <= now
            || typeof claims.room_code !== 'string'
            || !/^[A-Z2-9]{6}$/.test(claims.room_code)
            || typeof claims.user_id !== 'string'
            || claims.user_id.length === 0
            || typeof claims.username !== 'string'
            || claims.username.length < 2
            || claims.username.length > 32
            || !['host', 'player'].includes(claims.role)) return null;
        return claims;
    } catch {
        return null;
    }
}
