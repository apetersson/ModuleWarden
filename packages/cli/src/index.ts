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

const API_BASE = process.env.MW_API_BASE ?? 'http://localhost:8080';
const ADMIN_TOKEN = process.env.MW_AUTH_ADMIN_TOKENS?.split(',')[0]?.trim() ?? '';

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
  MW_API_BASE        ModuleWarden API URL (default: http://localhost:8080)
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
    ? `${API_BASE}/status/${encodeURIComponent(packageName)}`
    : `${API_BASE}/status`;

  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${process.env.MW_AUTH_DEV_TOKENS?.split(',')[0]?.trim() ?? ''}` },
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
    console.error(`Failed to reach ModuleWarden API at ${API_BASE}:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function cmdExplain(args: string[]): Promise<void> {
  const pkgArg = args[0];
  if (!pkgArg || !pkgArg.includes('@')) {
    console.error('Usage: modulewarden explain <package>@<version>');
    process.exit(1);
  }
  const [name, version] = pkgArg.split('@');

  try {
    const resp = await fetch(`${API_BASE}/status/${encodeURIComponent(name)}`, {
      headers: { Authorization: `Bearer ${process.env.MW_AUTH_DEV_TOKENS?.split(',')[0]?.trim() ?? ''}` },
    });
    if (!resp.ok) {
      console.error(`Error: ${resp.status} ${resp.statusText}`);
      process.exit(1);
    }
    const data = await resp.json();

    if (version && version !== data.version) {
      // Try the explain endpoint
      const explainResp = await fetch(
        `${API_BASE}/explain/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
        {
          headers: { Authorization: `Bearer ${process.env.MW_AUTH_DEV_TOKENS?.split(',')[0]?.trim() ?? ''}` },
        }
      );
      if (explainResp.ok) {
        const explainData = await explainResp.json();
        console.log(JSON.stringify(explainData, null, 2));
        return;
      }
    }

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

    const resp = await fetch(`${API_BASE}/admin/import-lockfile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN || (process.env.MW_AUTH_ADMIN_TOKENS?.split(',')[0]?.trim() ?? '')}`,
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
    console.error(`Failed to reach ModuleWarden API at ${API_BASE}:`, err instanceof Error ? err.message : String(err));
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
    const [, pkg, ver, target] = args;
    const reason = args.slice(4).join(' ') || 'Admin override';

    if (!['ALLOW', 'BLOCK', 'QUARANTINE'].includes(target.toUpperCase())) {
      console.error('Target must be ALLOW, BLOCK, or QUARANTINE');
      process.exit(1);
    }

    try {
      const resp = await fetch(`${API_BASE}/admin/override`, {
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
      const resp = await fetch(`${API_BASE}/admin/overrides`, {
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
