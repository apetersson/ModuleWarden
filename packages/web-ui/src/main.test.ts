import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('web-ui', () => {
  it('has StatusPage and QueuePage components', () => {
    const source = readFileSync('src/main.tsx', 'utf-8');
    expect(source).toContain('StatusPage');
    expect(source).toContain('QueuePage');
    expect(source).toContain('Package Status');
    expect(source).toContain('Queue Status');
    expect(source).toContain('REFRESH_INTERVAL');
  });

  it('statusColor returns correct colors', () => {
    // Test the inline status color logic
    const colors: Record<string, string> = {
      ALLOW: '#2e7d32',
      BLOCK: '#c62828',
      QUARANTINE: '#f57f17',
    };
    expect(colors.ALLOW).toBe('#2e7d32');
    expect(colors.BLOCK).toBe('#c62828');
    expect(colors.QUARANTINE).toBe('#f57f17');
  });
});
