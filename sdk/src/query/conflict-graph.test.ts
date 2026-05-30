/**
 * Unit tests for conflict-graph (issue #13, gap 1).
 *
 * Builds the file-overlap adjacency between phases from each PLAN.md's
 * `files_modified` frontmatter and partitions the phases into concurrency
 * waves. Hotspot-only overlaps (ROADMAP.md / STATE.md / register-all.ts) are
 * SOFT (trivial merge, same wave allowed); any other shared file is HARD
 * (serialize into a later wave).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { conflictGraph } from './conflict-graph.js';

interface ConflictEdge {
  phases: [string, string];
  files: string[];
  classification: 'soft' | 'hard';
}

interface ConflictGraphData {
  phases: Array<{ phase: string; files_modified: string[]; found: boolean }>;
  edges: ConflictEdge[];
  schedule: { waves: string[][] };
}

function plan(phase: string, filesModified: string[]): string {
  const list = filesModified.map((f) => `  - ${f}`).join('\n');
  return `---
phase: ${phase}
files_modified:
${list}
---

<objective>
O
</objective>
<tasks><task type="auto"><name>T</name></task></tasks>
`;
}

let tmpDir: string;

async function writePlan(phaseDir: string, fileName: string, content: string): Promise<void> {
  const dir = join(tmpDir, '.planning', 'phases', phaseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gsd-cgraph-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('conflictGraph', () => {
  it('places three pairwise-disjoint phases in one concurrent wave with no hard edges', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/decoders/curve.ts']));
    await writePlan('44-nonce', '44-PLAN.md', plan('44-nonce', ['src/solana/durable_nonce.ts']));
    await writePlan('45-ens', '45-PLAN.md', plan('45-ens', ['src/resolvers/ens.ts']));

    const r = await conflictGraph(['43', '44', '45'], tmpDir);
    const d = r.data as ConflictGraphData;

    expect(d.schedule.waves).toHaveLength(1);
    expect(d.schedule.waves[0].sort()).toEqual(['43', '44', '45']);
    expect(d.edges.filter((e) => e.classification === 'hard')).toHaveLength(0);
  });

  it('serializes two phases that share a real source file into different waves (hard conflict)', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/preview_send.ts', 'src/decoders/curve.ts']));
    await writePlan('46-preview', '46-PLAN.md', plan('46-preview', ['src/preview_send.ts']));

    const r = await conflictGraph(['43', '46'], tmpDir);
    const d = r.data as ConflictGraphData;

    const hard = d.edges.filter((e) => e.classification === 'hard');
    expect(hard).toHaveLength(1);
    expect(hard[0].files).toContain('src/preview_send.ts');
    expect(hard[0].phases.sort()).toEqual(['43', '46']);

    // Serialized: never in the same wave.
    const wavesWith43 = d.schedule.waves.findIndex((w) => w.includes('43'));
    const wavesWith46 = d.schedule.waves.findIndex((w) => w.includes('46'));
    expect(d.schedule.waves).toHaveLength(2);
    expect(wavesWith43).not.toBe(wavesWith46);
  });

  it('keeps phases that overlap only on hotspots in the same wave (soft conflict)', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/decoders/curve.ts', 'ROADMAP.md', 'STATE.md']));
    await writePlan('44-nonce', '44-PLAN.md', plan('44-nonce', ['src/solana/durable_nonce.ts', 'ROADMAP.md', 'STATE.md']));

    const r = await conflictGraph(['43', '44'], tmpDir);
    const d = r.data as ConflictGraphData;

    const edge = d.edges.find((e) => e.phases.includes('43') && e.phases.includes('44'));
    expect(edge).toBeDefined();
    expect(edge!.classification).toBe('soft');
    expect(edge!.files.sort()).toEqual(['ROADMAP.md', 'STATE.md']);

    // Soft overlap does not force serialization.
    expect(d.schedule.waves).toHaveLength(1);
    expect(d.schedule.waves[0].sort()).toEqual(['43', '44']);
  });

  it('treats a phase with empty/missing files_modified conservatively (hard against all, own wave)', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/decoders/curve.ts']));
    await writePlan('44-nonce', '44-PLAN.md', plan('44-nonce', ['src/solana/durable_nonce.ts']));
    // Phase 47 declares no files_modified at all.
    await writePlan(
      '47-unknown',
      '47-PLAN.md',
      `---
phase: 47-unknown
---

<objective>O</objective>
<tasks><task type="auto"><name>T</name></task></tasks>
`,
    );

    const r = await conflictGraph(['43', '44', '47'], tmpDir);
    const d = r.data as ConflictGraphData;

    // 47 hard-conflicts with both disjoint phases.
    const edges47 = d.edges.filter((e) => e.phases.includes('47'));
    expect(edges47).toHaveLength(2);
    expect(edges47.every((e) => e.classification === 'hard')).toBe(true);

    // 43 and 44 are disjoint -> share a wave; 47 is pushed to its own wave.
    const wave43 = d.schedule.waves.findIndex((w) => w.includes('43'));
    const wave44 = d.schedule.waves.findIndex((w) => w.includes('44'));
    const wave47 = d.schedule.waves.findIndex((w) => w.includes('47'));
    expect(wave43).toBe(wave44);
    expect(wave47).not.toBe(wave43);
  });

  it('unions files_modified across multiple PLAN.md files in one phase', async () => {
    // Phase 50 has two plans; the shared file lives only in its second plan.
    await writePlan('50-multi', '50-01-PLAN.md', plan('50-multi', ['src/a.ts']));
    await writePlan('50-multi', '50-02-PLAN.md', plan('50-multi', ['src/shared.ts']));
    await writePlan('51-other', '51-PLAN.md', plan('51-other', ['src/shared.ts']));

    const r = await conflictGraph(['50', '51'], tmpDir);
    const d = r.data as ConflictGraphData;

    const phase50 = d.phases.find((p) => p.phase === '50');
    expect(phase50!.files_modified.sort()).toEqual(['src/a.ts', 'src/shared.ts']);

    const edge = d.edges.find((e) => e.phases.includes('50') && e.phases.includes('51'));
    expect(edge!.classification).toBe('hard');
    expect(edge!.files).toContain('src/shared.ts');
  });

  it('marks a phase whose directory does not exist as not found and conservative', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/decoders/curve.ts']));

    const r = await conflictGraph(['43', '99'], tmpDir);
    const d = r.data as ConflictGraphData;

    const missing = d.phases.find((p) => p.phase === '99');
    expect(missing!.found).toBe(false);
    expect(missing!.files_modified).toEqual([]);
    // Missing phase is conservative: hard edge to 43 and a separate wave.
    const edge = d.edges.find((e) => e.phases.includes('99'));
    expect(edge!.classification).toBe('hard');
  });
});
