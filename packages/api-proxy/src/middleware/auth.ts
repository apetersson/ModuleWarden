/**
 * Shared auth middleware for ModuleWarden API proxy.
 *
 * Extracts the duplicated `checkAdmin` pattern from routes/admin.ts
 * and routes/dashboard.ts into a single Fastify preHandler hook.
 */

import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Check whether the request carries a valid admin token.
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
  const adminEnv = process.env.MW_AUTH_ADMIN_TOKENS;
  if (!adminEnv) {
    reply.status(503).send({ error: 'Admin auth not configured: set MW_AUTH_ADMIN_TOKENS' });
    return false;
  }
  const adminTokens = adminEnv.split(',').map((t) => t.trim()).filter(Boolean);

  if (!adminTokens.includes(token)) {
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
