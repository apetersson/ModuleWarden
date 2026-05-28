#!/usr/bin/env node
/**
 * ModuleWarden Developer CLI
 *
 * Commands:
 *   modulewarden preflight [lockfile]   — Import lockfile and start preflight audit
 *   modulewarden status [package]       — Show package review status
 *   modulewarden admin override <args>  — Admin commands for overrides
 *   modulewarden version                — Show version
 */

import { readFileSync, existsSync } from 'node:fs';
import { MODULEWARDEN_VERSION } from '@modulewarden/shared/constants';

function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`Error: ${name} is not set. ${hint ?? ''}`.trim());
    process.exit(1);
  }
  return value.trim();
}

/** Lazy API base URL — validated on first use, not at module load. */
let _apiBase: string | null = null;
function getApiBase(): string {
  if (!_apiBase) {
    _apiBase = requireEnv('MW_API_BASE', 'Set it to the ModuleWarden API URL (e.g. http://localhost:8080).');
  }
  return _apiBase;
}

function getDevToken(): string {
  const token = process.env.MW_AUTH_DEV_TOKENS?.split(',')[0]?.trim();
  if (!token) {
    console.error('Error: MW_AUTH_DEV_TOKENS is not set. Set it to your developer token.');
    process.exit(1);
  }
  return token;
}

const ADMIN_TOKEN = (() => {
  const token = process.env.MW_AUTH_ADMIN_TOKENS?.split(',')[0]?.trim();
  return token ?? '';
})();

function printHelp(): void {
  console.log(`
ModuleWarden v${MODULEWARDEN_VERSION} — Private agentic version-diff gate

Usage:
  modulewarden preflight [lockfile]    Import lockfile and audit all packages
  modulewarden status [package]        Show package review status
  modulewarden explain <pkg>@<ver>     Detailed explanation for a version
  modulewarden admin override           Manage overrides
  modulewarden version                  Show version
  modulewarden help                     Show this help

Environment:
  MW_API_BASE        ModuleWarden API URL (required)
  MW_AUTH_ADMIN_TOKENS  Comma-separated admin tokens
  MW_AUTH_DEV_TOKENS    Comma-separated developer tokens
`);
}

async function cmdVersion(): Promise<void> {
  console.log(`ModuleWarden v${MODULEWARDEN_VERSION}`);
}

async function cmdStatus(args: string[]): Promise<void> {
  const packageName = args[0];
  const url = packageName
    ? `${getApiBase()}/status/${encodeURIComponent(packageName)}`
    : `${getApiBase()}/status`;

  try {
    const devToken = getDevToken();
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${devToken}` },
    });
    if (!resp.ok) {
      console.error(`Error: ${resp.status} ${resp.statusText}`);
      const body = await resp.text().catch(() => '');
      if (body) console.error(body.slice(0, 500));
      process.exit(1);
    }
    const data = await resp.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to reach ModuleWarden API at ${getApiBase()}:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function parsePackageArg(arg: string): { name: string; version?: string } | null {
  // Scoped packages: @scope/name@version (H-1)
  // Unscoped: name@version
  // Split on the LAST @ only (after the scope @)
  if (!arg) return null;
  if (arg.startsWith('@')) {
    // @scope/name@version -> ['@scope/name', 'version'] or ['@scope/name']
    const atIndex = arg.indexOf('@', 1);
    if (atIndex === -1) return { name: arg };
    return { name: arg.slice(0, atIndex), version: arg.slice(atIndex + 1) };
  }
  const parts = arg.split('@');
  if (parts.length === 1) return { name: arg };
  const name = parts[0];
  if (!name) return null;
  return { name, version: parts.slice(1).join('@') };
}

async function cmdExplain(args: string[]): Promise<void> {
  const pkgArg = args[0];
  const parsed = pkgArg ? parsePackageArg(pkgArg) : null;
  if (!parsed?.version) {
    console.error('Usage: modulewarden explain <package>@<version>');
    console.error('Examples:');
    console.error('  modulewarden explain lodash@4.17.21');
    console.error('  modulewarden explain @babel/core@7.21.0');
    process.exit(1);
  }

  try {
    const devToken = getDevToken();
    const resp = await fetch(
      `${getApiBase()}/explain/${encodeURIComponent(parsed.name)}/${encodeURIComponent(parsed.version)}`,
      {
        headers: { Authorization: `Bearer ${devToken}` },
      }
    );
    if (!resp.ok) {
      console.error(`Explain API returned ${resp.status} ${resp.statusText}`);
      const body = await resp.text().catch(() => '');
      if (body) console.error(body.slice(0, 500));
      process.exit(1);
    }
    const data = await resp.json();
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Failed to reach ModuleWarden API:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdPreflight(args: string[]): Promise<void> {
  const lockfilePath = args[0] || 'pnpm-lock.yaml';

  if (!existsSync(lockfilePath)) {
    console.error(`Lockfile not found: ${lockfilePath}`);
    console.error('Usage: modulewarden preflight [lockfile-path]');
    process.exit(1);
  }

  console.log(`[preflight] Importing lockfile: ${lockfilePath}`);

  try {
    const lockfileContent = readFileSync(lockfilePath, 'utf-8');
    const format = lockfilePath.endsWith('.yaml') || lockfilePath.endsWith('.yml') ? 'pnpm' : 'npm';

    const resp = await fetch(`${getApiBase()}/admin/import-lockfile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        filename: lockfilePath,
        format,
        content: lockfileContent.slice(0, 1_000_000), // First 1MB
      }),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`Import failed: ${resp.status} ${body.slice(0, 300)}`);
      process.exit(1);
    }

    const result = await resp.json();
    console.log(`[preflight] Imported ${result.packageCount ?? '?'} packages`);
    console.log(`[preflight] Created ${result.subscriptionCount ?? '?'} subscriptions`);
    console.log(`[preflight] Enqueued ${result.reviewCount ?? '?'} reviews`);
    console.log(`[preflight] Run 'modulewarden status' to check progress.`);
  } catch (err) {
    console.error(`Failed to reach ModuleWarden API at ${getApiBase()}:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdAdmin(args: string[]): Promise<void> {
  if (args.length === 0) {
    console.log('Admin commands:');
    console.log('  modulewarden admin override <pkg> <ver> <target> "reason"');
    console.log('  modulewarden admin list-overrides');
    console.log('  modulewarden admin remove-override <id>');
    process.exit(0);
  }

  if (!ADMIN_TOKEN) {
    console.error('Admin token required. Set MW_AUTH_ADMIN_TOKENS environment variable.');
    process.exit(1);
  }

  const subCmd = args[0];

  if (subCmd === 'override' && args.length >= 4) {
    const pkg = args[1]!;
    const ver = args[2]!;
    const target = args[3]!;
    const reason = args.slice(4).join(' ') || 'Admin override';

    if (!['ALLOW', 'BLOCK', 'QUARANTINE'].includes(target.toUpperCase())) {
      console.error('Target must be ALLOW, BLOCK, or QUARANTINE');
      process.exit(1);
    }

    try {
      const resp = await fetch(`${getApiBase()}/admin/override`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          packageName: pkg,
          version: ver,
          targetVerdict: target.toUpperCase(),
          reason,
          scope: 'SPECIFIC_VERSION',
        }),
      });

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`Override failed: ${resp.status} ${body.slice(0, 300)}`);
        process.exit(1);
      }

      const result = await resp.json();
      console.log(`Override created: ${result.overrideId ?? result.id}`);
    } catch (err) {
      console.error(`Failed:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else if (subCmd === 'list-overrides') {
    try {
      const resp = await fetch(`${getApiBase()}/admin/overrides`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      if (!resp.ok) {
        console.error(`Error: ${resp.status}`);
        process.exit(1);
      }
      const data = await resp.json();
      console.log(JSON.stringify(data, null, 2));
    } catch (err) {
      console.error(`Failed:`, err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    console.error('Unknown admin command. Use: modulewarden admin');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';

  switch (cmd) {
    case 'preflight':
      await cmdPreflight(args.slice(1));
      break;
    case 'status':
      await cmdStatus(args.slice(1));
      break;
    case 'explain':
      await cmdExplain(args.slice(1));
      break;
    case 'admin':
      await cmdAdmin(args.slice(1));
      break;
    case 'version':
    case '--version':
      await cmdVersion();
      break;
    case 'help':
    case '--help':
    default:
      printHelp();
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
