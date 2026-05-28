/**
 * Shared auth middleware for ModuleWarden API proxy.
 *
 * Extracts the duplicated `checkAdmin` pattern from routes/admin.ts
 * and routes/dashboard.ts into a single Fastify preHandler hook.
 *
 * Tokens are stored as SHA-256 hashes at startup and compared using
 * timing-safe comparison (crypto.timingSafeEqual) to prevent timing
 * side-channel attacks (S-2).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 hash of a token for timing-safe storage. */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf-8').digest();
}

/** Hashed admin tokens, computed once at import time. */
let hashedAdminTokens: Buffer[] | null = null;

function initHashedTokens(): Buffer[] | null {
  const adminEnv = process.env.MW_AUTH_ADMIN_TOKENS;
  if (!adminEnv) return null;
  return adminEnv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(hashToken);
}

/**
 * Compare two buffers using timing-safe comparison.
 * Handles different-length inputs by hashing the shorter one.
 */
function safeBufferEquals(a: Buffer, b: Buffer): boolean {
  // Use timingSafeEqual on equal-length candidates
  // Hash both to equal length for actual comparison
  if (a.length === b.length) {
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Check whether the request carries a valid admin token.
 * Uses SHA-256 hashed comparison with timingSafeEqual.
 * Returns `true` if authorized, `false` if a response was already sent.
 *
 * Usage as a preHandler:
 * ```
 * app.get('/admin/foo', { preHandler: [requireAdmin] }, handler);
 * ```
 * Or inline when the handler needs to return early:
 * ```
 * if (!checkAdmin(request, reply)) return;
 * ```
 */
export function checkAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Authentication required' });
    return false;
  }

  const token = authHeader.slice(7);

  if (!hashedAdminTokens) {
    hashedAdminTokens = initHashedTokens();
  }

  if (!hashedAdminTokens || hashedAdminTokens.length === 0) {
    reply.status(503).send({ error: 'Admin auth not configured: set MW_AUTH_ADMIN_TOKENS' });
    return false;
  }

  const requestHash = hashToken(token);

  const matched = hashedAdminTokens.some((storedHash) => safeBufferEquals(storedHash, requestHash));

  if (!matched) {
    reply.status(403).send({ error: 'Forbidden: admin token required' });
    return false;
  }

  return true;
}

/**
 * Fastify preHandler hook that rejects non-admin requests.
 * Attach to routes: `{ preHandler: [requireAdmin] }`
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!checkAdmin(request, reply)) {
    reply.send(); // Ensure the response is sent
  }
}
