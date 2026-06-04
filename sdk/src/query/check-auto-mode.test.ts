/**
 * Unit tests for `check.auto-mode` (decision-routing audit §3.5).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAutoMode } from './check-auto-mode.js';

describe('checkAutoMode', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(tmpdir(), `gsd-auto-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it('returns defaults when config.json is missing', async () => {
    const { data } = await checkAutoMode([], projectDir);
    expect(data).toEqual({
      active: false,
      source: 'none',
      auto_chain_active: false,
      auto_advance: false,
      unattended: false,
      human_reachable: true,
    });
  });

  it('active true when only auto_advance is set', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { auto_advance: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    expect(data).toMatchObject({
      active: true,
      source: 'auto_advance',
      auto_advance: true,
      auto_chain_active: false,
    });
  });

  it('active true when only _auto_chain_active is set', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { _auto_chain_active: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    expect(data).toMatchObject({
      active: true,
      source: 'auto_chain',
      auto_advance: false,
      auto_chain_active: true,
    });
  });

  it('uses source both when both flags are true', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { auto_advance: true, _auto_chain_active: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    expect(data).toMatchObject({
      active: true,
      source: 'both',
      auto_advance: true,
      auto_chain_active: true,
    });
  });

  it('exposes unattended + human_reachable=false when unattended is set', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { unattended: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    expect(data).toMatchObject({ unattended: true, human_reachable: false });
    // unattended is NOT auto-mode by itself — it does not set `active`.
    expect((data as { active: boolean }).active).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #25 (gap 12) — auto-determination checkpoint falsifier.
//
// Guards the real `checkAutoMode` flag-derivation contract: `unattended` is
// the dedicated trust source, derived independently from `auto_advance`; and
// `human_reachable` is its strict negation. These assertions exercise the
// production module (check-auto-mode.ts) — mutating the `unattended` or
// `human_reachable` derivation there breaks them.
//
// The checkpoint resolution ORDER (blocking-human halt → deterministic resolver
// → unattended-gated fallback → else pause) is enforced in the prose handlers
// (checkpoints.md / gsd-executor.md / execute-phase.md) — it is NOT in SDK
// code and is NOT re-stated here.
// ─────────────────────────────────────────────────────────────────────────────

describe('auto-determination checkpoint policy (#25 gap 12 falsifier)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(tmpdir(), `gsd-auto-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // Assertion 1: unattended:true → checkAutoMode surfaces unattended=true and
  // human_reachable=false (the two signals checkpoint consumers gate on).
  it('workflow.unattended:true → unattended=true and human_reachable=false', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { unattended: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    const d = data as { unattended: boolean; human_reachable: boolean };
    expect(d.unattended).toBe(true);
    expect(d.human_reachable).toBe(false);
  });

  // Assertion 2: no unattended config → unattended=false and human_reachable=true.
  it('default config (no unattended) → unattended=false and human_reachable=true', async () => {
    const { data } = await checkAutoMode([], projectDir);
    const d = data as { unattended: boolean; human_reachable: boolean };
    expect(d.unattended).toBe(false);
    expect(d.human_reachable).toBe(true);
  });

  // Assertion 3 — SECURITY-CRITICAL: auto_advance:true (and/or _auto_chain_active)
  // with unattended unset → unattended MUST remain false. Fails if someone makes
  // checkAutoMode derive `unattended` from `auto_advance` (wrong trust source).
  it('auto_advance:true with unattended unset → unattended=false (auto_advance is NOT proxied as trust source)', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { auto_advance: true, _auto_chain_active: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    const d = data as { unattended: boolean; human_reachable: boolean; auto_advance: boolean; auto_chain_active: boolean };
    expect(d.auto_advance).toBe(true);
    expect(d.auto_chain_active).toBe(true);
    // The critical invariant: auto_advance/chain does NOT set unattended.
    expect(d.unattended).toBe(false);
    expect(d.human_reachable).toBe(true);
  });
});
