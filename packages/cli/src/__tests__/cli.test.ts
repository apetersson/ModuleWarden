import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

describe('CLI', () => {
  it('CLI source exists', () => {
    expect(existsSync('src/index.ts')).toBe(true);
  });

  it('CLI module can be loaded', async () => {
    const cli = await import('../index.js');
    expect(cli).toBeDefined();
  });

  it('reads correct package name', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.name).toBe('@modulewarden/cli');
  });
});
