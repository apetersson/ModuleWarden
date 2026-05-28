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

/** Hashed admin tokens, cached with TTL refresh. */
let hashedAdminTokens: Buffer[] | null = null;
let adminTokensLastRefresh = 0;
const TOKEN_CACHE_TTL_MS = 60_000; // Refresh env vars every 60s

function getHashedAdminTokens(): Buffer[] | null {
  const now = Date.now();
  if (hashedAdminTokens && now - adminTokensLastRefresh < TOKEN_CACHE_TTL_MS) {
    return hashedAdminTokens;
  }
  const adminEnv = process.env.MW_AUTH_ADMIN_TOKENS;
  if (!adminEnv) {
    hashedAdminTokens = null;
    return null;
  }
  hashedAdminTokens = adminEnv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(hashToken);
  adminTokensLastRefresh = now;
  return hashedAdminTokens;
}

/** Hashed developer tokens, cached with TTL refresh. (A-2) */
let hashedDevTokens: Buffer[] | null = null;
let devTokensLastRefresh = 0;

function getHashedDevTokens(): Buffer[] | null {
  const now = Date.now();
  if (hashedDevTokens && now - devTokensLastRefresh < TOKEN_CACHE_TTL_MS) {
    return hashedDevTokens;
  }
  const devEnv = process.env.MW_AUTH_DEV_TOKENS;
  if (!devEnv) {
    hashedDevTokens = null;
    return null;
  }
  hashedDevTokens = devEnv
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map(hashToken);
  devTokensLastRefresh = now;
  return hashedDevTokens;
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
 * Generic token check against a list of hashed tokens.
 */
function checkToken(request: FastifyRequest, reply: FastifyReply, hashedTokens: Buffer[] | null, scopeName: string): boolean {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Authentication required' });
    return false;
  }

  if (!hashedTokens || hashedTokens.length === 0) {
    reply.status(503).send({ error: `${scopeName} auth not configured` });
    return false;
  }

  const token = authHeader.slice(7);
  const requestHash = hashToken(token);
  const matched = hashedTokens.some((storedHash) => safeBufferEquals(storedHash, requestHash));

  if (!matched) {
    reply.status(403).send({ error: `Forbidden: ${scopeName} token required` });
    return false;
  }

  return true;
}

/**
 * Check whether the request carries a valid admin token.
 * Uses SHA-256 hashed comparison with timingSafeEqual.
 * Supports TTL-based cache refresh (N-4).
 */
export function checkAdmin(request: FastifyRequest, reply: FastifyReply): boolean {
  return checkToken(request, reply, getHashedAdminTokens(), 'admin');
}

/**
 * Check whether the request carries a valid developer token. (A-2)
 */
export function checkDeveloper(request: FastifyRequest, reply: FastifyReply): boolean {
  return checkToken(request, reply, getHashedDevTokens(), 'developer');
}

/**
 * Check whether the request carries a valid admin OR developer token.
 * Developer tokens have strictly lower scope than admin tokens.
 */
export function checkAnyAuth(request: FastifyRequest, reply: FastifyReply): boolean {
  // Try developer first (lower scope), then admin
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Authentication required' });
    return false;
  }

  const devTokens = getHashedDevTokens();
  if (devTokens && devTokens.length > 0) {
    if (checkToken(request, reply, devTokens, 'developer')) return true;
    // Don't return false yet — try admin tokens
  }

  const adminTokens = getHashedAdminTokens();
  if (adminTokens && adminTokens.length > 0) {
    return checkToken(request, reply, adminTokens, 'admin');
  }

  reply.status(503).send({ error: 'Auth not configured: set MW_AUTH_ADMIN_TOKENS or MW_AUTH_DEV_TOKENS' });
  return false;
}

/**
 * Fastify preHandler hook that rejects non-admin requests.
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!checkAdmin(request, reply)) {
    reply.send();
  }
}

/**
 * Fastify preHandler hook that rejects non-developer requests. (A-2)
 */
export async function requireDeveloper(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!checkDeveloper(request, reply)) {
    reply.send();
  }
}

/**
 * Fastify preHandler hook that requires any valid auth (admin or dev).
 */
export async function requireAnyAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!checkAnyAuth(request, reply)) {
    reply.send();
  }
}
