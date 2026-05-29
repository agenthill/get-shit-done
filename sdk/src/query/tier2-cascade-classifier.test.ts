/**
 * Tier-2 cascade TRISTATE classifier — unit/integration tests against a real
 * temp git repo (ADR 0013 option 4, chunk 3, Task B2).
 *
 * Falsifies the ATTRIBUTABLE-ONLY-else-HALT decision and the #2983 rule that an
 * inability to decide (cannot-classify) NEVER masquerades as a confident
 * no-cascade.
 */

import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { classifyCascade } from './tier2-cascade-classifier.js';
import type { PhaseManifest, PhaseManifestEntry } from './phase-manifest.js';

const execFileAsync = promisify(execFile);
const gitIn = (dir: string) => (args: string[]) => execFileAsync('git', args, { cwd: dir });

/** Init a repo and create one commit per phase, each touching the given files.
 * Returns the repo dir + a manifest with each phase's real commit sha + paths. */
async function repoWithPhases(
  phases: Array<{ phase: string; files: string[]; dependsOn: string[] }>,
): Promise<{ dir: string; manifest: PhaseManifest }> {
  const dir = await mkdtemp(join(tmpdir(), 'gsd-cc-'));
  const git = gitIn(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 't@t.t']);
  await git(['config', 'user.name', 'T']);
  await git(['config', 'commit.gpgsign', 'false']);
  await writeFile(join(dir, 'seed.txt'), 'seed\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '--no-verify', '-m', 'seed']);

  const manifest: PhaseManifest = {};
  let baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  let promoteCounter = 0;
  for (const { phase, files, dependsOn } of phases) {
    for (const f of files) {
      const full = join(dir, f);
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, `phase ${phase} content\n`);
    }
    await git(['add', '-A']);
    await git(['commit', '-q', '--no-verify', '-m', `phase ${phase} work`]);
    const headSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    promoteCounter += 1;
    const entry: PhaseManifestEntry = {
      base_tag: `gsd/phase-${phase}-base`,
      base_sha: baseSha,
      head_sha: headSha,
      commits: [headSha],
      // Monotonic promoted_at so reverse-promotion-order is deterministic.
      promoted_at: new Date(Date.UTC(2026, 0, 1, 0, promoteCounter)).toISOString(),
      depends_on: dependsOn,
    };
    manifest[phase] = entry;
    baseSha = headSha;
  }
  return { dir, manifest };
}

describe('classifyCascade — ATTRIBUTABLE-ONLY else HALT', () => {
  it('revert-confident: phase 3 depends_on 2, failure attributable to phase-2 file → cascade [2]', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: [] },
      { phase: '2', files: ['b.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        // Phase 3 has NOT promoted; it depends on 2 and the break is in b.ts.
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } as PhaseManifestEntry },
        implicatedFiles: ['b.ts'],
      });
      expect(res.verdict).toBe('revert-confident');
      expect(res.cascadeSet).toEqual(['2']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no over-cascade: an independent promoted phase NOT in the closure is never reverted', async () => {
    // Phase 1 (independent), phase 2 depends_on 1. Phase 3 depends_on ONLY 2.
    // The break is in phase-2's file. Phase 1 is in the closure (2→1) but is NOT
    // file-attributable, so it must NOT be reverted; only phase 2.
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['indep.ts'], dependsOn: [] },
      { phase: '2', files: ['shared.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } as PhaseManifestEntry },
        implicatedFiles: ['shared.ts'],
      });
      expect(res.verdict).toBe('revert-confident');
      expect(res.cascadeSet).toEqual(['2']); // NOT ['2','1']
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cascade set ordered REVERSE promotion order (newest-promoted first)', async () => {
    // 3 depends_on 1 and 2; both attributable. Promotion order 1 then 2, so the
    // cascade set must be [2,1].
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['one.ts'], dependsOn: [] },
      { phase: '2', files: ['two.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['1', '2'], commits: [] } as PhaseManifestEntry },
        implicatedFiles: ['one.ts', 'two.ts'],
      });
      expect(res.verdict).toBe('revert-confident');
      expect(res.cascadeSet).toEqual(['2', '1']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no-cascade-confident: depends_on-linked predecessor exists but is NOT file-attributable', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: [] },
      { phase: '2', files: ['b.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } as PhaseManifestEntry },
        // Break is in a brand-new file phase 2 never touched.
        implicatedFiles: ['phase3-new.ts'],
      });
      expect(res.verdict).toBe('no-cascade-confident');
      expect(res.cascadeSet).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('no-cascade-confident: no promoted predecessor in the closure', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: [] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '2',
        // Phase 2 depends on nothing promoted.
        manifest: { ...manifest, '2': { ...manifest['1']!, depends_on: [], commits: [] } as PhaseManifestEntry },
        implicatedFiles: ['a.ts'],
      });
      expect(res.verdict).toBe('no-cascade-confident');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cannot-classify: cyclic phase depends_on graph', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: ['2'] },
      { phase: '2', files: ['b.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '2',
        manifest,
        implicatedFiles: ['a.ts'],
      });
      expect(res.verdict).toBe('cannot-classify');
      expect(res.reason).toMatch(/cycl/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cannot-classify: structurally corrupt manifest entry', async () => {
    const res = await classifyCascade({
      projectDir: '/nonexistent',
      failingPhase: '2',
      manifest: { '1': { base_tag: 'x' } as unknown as PhaseManifestEntry },
      implicatedFiles: ['a.ts'],
    });
    expect(res.verdict).toBe('cannot-classify');
  });

  it('cannot-classify: implicated files uncertain is NEVER downgraded to no-cascade', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: [] },
      { phase: '2', files: ['b.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } as PhaseManifestEntry },
        implicatedFiles: [],
        implicatedFilesUncertain: true,
      });
      // The whole point: ambiguity HALTs, it does not become no-cascade.
      expect(res.verdict).toBe('cannot-classify');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('empty implicated set (but CERTAIN) → no-cascade, not cannot-classify', async () => {
    const { dir, manifest } = await repoWithPhases([
      { phase: '1', files: ['a.ts'], dependsOn: [] },
      { phase: '2', files: ['b.ts'], dependsOn: ['1'] },
    ]);
    try {
      const res = await classifyCascade({
        projectDir: dir,
        failingPhase: '3',
        manifest: { ...manifest, '3': { ...manifest['2']!, depends_on: ['2'], commits: [] } as PhaseManifestEntry },
        implicatedFiles: [],
      });
      expect(res.verdict).toBe('no-cascade-confident');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
