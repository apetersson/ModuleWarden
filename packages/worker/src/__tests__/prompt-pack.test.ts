import { describe, expect, it } from 'vitest';
import { buildContainerInstructionFile, type AuditInstructions } from '../services/prompt-pack.js';

describe('prompt-pack container instructions', () => {
  it('lists beautification helpers in the private audit instructions', () => {
    const instructions: AuditInstructions = {
      packageName: 'minified-fixture',
      packageVersion: '1.0.0',
      isColdStart: true,
      corePromptVersions: ['core-version-diff-supply-chain-review@2026.05'],
      patternPromptVersions: ['pattern-minified-source-normalization@2026.05'],
      customPromptNames: [],
      escalationPromptVersions: [],
      promptSections: [{
        name: 'pattern-minified-source-normalization',
        version: '2026.05',
        category: 'PATTERN_CHECK',
        hash: 'test-hash',
        content: [
          'Use prettier and js-beautify on copies of minified files.',
          'Verify security-relevant findings against the original artifact.',
        ].join('\n'),
      }],
      instructionsText: 'Cold-start audit: no predecessor version available.',
      modelProfile: {
        name: 'test-model',
        baseUrl: 'http://model.test',
        modelName: 'test-model-name',
      },
      needsEscalation: false,
      escalationModelProfile: null,
    };

    const rendered = buildContainerInstructionFile(instructions);

    expect(rendered).toContain('pattern-minified-source-normalization@2026.05');
    expect(rendered).toContain('prettier');
    expect(rendered).toContain('js-beautify');
    expect(rendered).toContain('original artifact');
  });
});
