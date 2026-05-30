/**
 * Phase-level depends_on parsing + transitive closure + PHASE-TIER cycle check
 * (ADR 0013 option 4, chunk 3, Task B1).
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalizePhaseId,
  parsePhaseDependsOn,
  transitiveDependsOnClosure,
  readPhaseDependsOn,
} from './phase-depends-on.js';
import type { PhaseManifest, PhaseManifestEntry } from './phase-manifest.js';

function entry(dependsOn: string[]): PhaseManifestEntry {
  return {
    base_tag: 'gsd/phase-x-base',
    base_sha: 'a'.repeat(40),
    head_sha: 'b'.repeat(40),
    commits: [],
    promoted_at: '2026-01-01T00:00:00.000Z',
    depends_on: dependsOn,
  };
}

describe('canonicalizePhaseId', () => {
  it('strips leading zeros and the Phase keyword, preserves decimals + letters', () => {
    expect(canonicalizePhaseId('Phase 02')).toBe('2');
    expect(canonicalizePhaseId('03')).toBe('3');
    expect(canonicalizePhaseId('Phase 05.1')).toBe('5.1');
    expect(canonicalizePhaseId('12A')).toBe('12A');
    expect(canonicalizePhaseId('  Phase 7  ')).toBe('7');
  });
  it('returns empty for non-phase tokens', () => {
    expect(canonicalizePhaseId('None')).toBe('');
    expect(canonicalizePhaseId('TBD')).toBe('');
    expect(canonicalizePhaseId('')).toBe('');
  });
});

describe('parsePhaseDependsOn', () => {
  it('parses single, comma, and prose-joined dependency lists', () => {
    expect(parsePhaseDependsOn('Phase 2')).toEqual(['2']);
    expect(parsePhaseDependsOn('Phase 1, Phase 3')).toEqual(['1', '3']);
    expect(parsePhaseDependsOn('1, 2')).toEqual(['1', '2']);
    expect(parsePhaseDependsOn('Phase 2 and Phase 4')).toEqual(['2', '4']);
    expect(parsePhaseDependsOn('Phase 1 Phase 3')).toEqual(['1', '3']);
  });
  it('drops non-phase free text and dedupes', () => {
    expect(parsePhaseDependsOn('None')).toEqual([]);
    expect(parsePhaseDependsOn('TBD')).toEqual([]);
    expect(parsePhaseDependsOn(null)).toEqual([]);
    expect(parsePhaseDependsOn('Phase 2, Phase 2')).toEqual(['2']);
  });
});

describe('transitiveDependsOnClosure', () => {
  it('computes the transitive closure excluding the start phase', () => {
    const manifest: PhaseManifest = {
      '1': entry([]),
      '2': entry(['1']),
      '3': entry(['2']),
    };
    const { closure, hasCycle } = transitiveDependsOnClosure(manifest, '3');
    expect(hasCycle).toBe(false);
    expect(closure.sort()).toEqual(['1', '2']);
  });

  it('includes a depends_on edge even when its target is not yet in the manifest', () => {
    // Phase 3 depends on 2, but 2 has not promoted (absent from manifest). The
    // edge still belongs to the closure (the classifier intersects with promoted
    // phases later); it just is not traversed further. Not a cycle.
    const manifest: PhaseManifest = { '3': entry(['2']) };
    const { closure, hasCycle } = transitiveDependsOnClosure(manifest, '3');
    expect(hasCycle).toBe(false);
    expect(closure).toEqual(['2']);
  });

  it('detects a direct self-cycle', () => {
    const manifest: PhaseManifest = { '1': entry(['1']) };
    const { hasCycle } = transitiveDependsOnClosure(manifest, '1');
    expect(hasCycle).toBe(true);
  });

  it('detects a multi-node cycle in the phase graph (PHASE-TIER cycle check)', () => {
    const manifest: PhaseManifest = {
      '1': entry(['3']),
      '2': entry(['1']),
      '3': entry(['2']),
    };
    const { hasCycle } = transitiveDependsOnClosure(manifest, '3');
    expect(hasCycle).toBe(true);
  });

  it('canonicalizes both manifest keys and edges so padded/Phase-prefixed forms match', () => {
    const manifest: PhaseManifest = {
      '02': entry([]),
      '03': entry(['Phase 02']),
    };
    const { closure, hasCycle } = transitiveDependsOnClosure(manifest, '3');
    expect(hasCycle).toBe(false);
    expect(closure).toEqual(['2']);
  });
});

describe('readPhaseDependsOn', () => {
  it('reads + parses the **Depends on:** line for the right phase section', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-dep-'));
    try {
      await mkdir(join(dir, '.planning'), { recursive: true });
      await writeFile(
        join(dir, '.planning', 'ROADMAP.md'),
        [
          '### Phase 1: Foundation',
          '**Goal:** lay it',
          '**Depends on:** None',
          '',
          '### Phase 2: Build',
          '**Goal:** build it',
          '**Depends on:** Phase 1',
          '',
          '### Phase 3: Ship',
          '**Goal:** ship it',
          '**Depends on:** Phase 1, Phase 2',
          '',
        ].join('\n'),
      );
      expect(await readPhaseDependsOn(dir, '1')).toEqual([]);
      expect(await readPhaseDependsOn(dir, '2')).toEqual(['1']);
      expect((await readPhaseDependsOn(dir, '3')).sort()).toEqual(['1', '2']);
      // Absent phase → [].
      expect(await readPhaseDependsOn(dir, '9')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when ROADMAP is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gsd-dep-'));
    try {
      expect(await readPhaseDependsOn(dir, '1')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
