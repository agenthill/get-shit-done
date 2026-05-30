import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scheduleWavesForPhases } from './query/wave-scheduler.js';

let tmpDir: string;

function plan(phase: string, filesModified: string[]): string {
  const list = filesModified.map((f) => `  - ${f}`).join('\n');
  return `---\nphase: ${phase}\nfiles_modified:\n${list}\n---\n\n<objective>O</objective>\n<tasks><task type="auto"><name>T</name></task></tasks>\n`;
}
async function writePlan(phaseDir: string, fileName: string, content: string): Promise<void> {
  const dir = join(tmpDir, '.planning', 'phases', phaseDir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content);
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'gsd-wsched-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('scheduleWavesForPhases', () => {
  it('returns disjoint phases in one wave and serializes a hard conflict', async () => {
    await writePlan('43-curve', '43-PLAN.md', plan('43-curve', ['src/a.ts']));
    await writePlan('44-nonce', '44-PLAN.md', plan('44-nonce', ['src/b.ts']));
    await writePlan('46-prev', '46-PLAN.md', plan('46-prev', ['src/a.ts']));

    const r = await scheduleWavesForPhases(['43', '44', '46'], tmpDir);
    // 43 and 44 are disjoint → can share a wave; 46 hard-conflicts with 43.
    const wave43 = r.waves.findIndex((w) => w.includes('43'));
    const wave46 = r.waves.findIndex((w) => w.includes('46'));
    expect(wave43).not.toBe(wave46);
    expect(r.footprints.find((p) => p.phase === '43')!.files_modified).toEqual(['src/a.ts']);
    expect(r.edges.some((e) => e.classification === 'hard')).toBe(true);
  });

  it('throws on fewer than two phases (matches conflict-graph contract)', async () => {
    await expect(scheduleWavesForPhases(['43'], tmpDir)).rejects.toThrow(/at least two phases/);
  });
});
