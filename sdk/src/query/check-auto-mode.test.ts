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
// Issue #25 (gap 12) — auto-determination checkpoint FALSIFIER.
//
// Three assertions that encode the two LOCKED design decisions. Each must FAIL
// if its decision is mis-implemented. The checkpoint-resolution policy is the
// behavioral contract documented in checkpoints.md / gsd-executor.md /
// execute-phase.md; `resolveCheckpoint` below is the executable model of that
// contract, gated on the resolver's `unattended` / `human_reachable` output —
// the SINGLE trust source. If the policy ever proxied `auto_advance` as the
// trust source, or defaulted `unattended` true, or auto-resolved a
// `gate="blocking-human"` checkpoint, one of these assertions breaks.
// ─────────────────────────────────────────────────────────────────────────────

type CheckpointKind = 'human-verify' | 'human-action' | 'decision';
interface Checkpoint {
  kind: CheckpointKind;
  /** Auth/security gate — NEVER auto-resolves, even when unattended. */
  gate?: 'blocking' | 'blocking-human';
  /** A deterministic resolver/criterion is available for this checkpoint. */
  deterministicResolution?: 'approved' | 'done' | string | null;
  /** Declared conservative safe/refusal branch. resolution="auto" requires it. */
  fallback?: string | null;
}
type CheckpointOutcome =
  | { action: 'resolve'; via: 'deterministic' | 'fallback'; response: string; continues: true }
  | { action: 'halt'; reason: string; continues: false };

/**
 * Executable model of the locked auto-determination checkpoint contract.
 * `unattended` is the resolver-derived trust source (NOT auto_advance).
 */
function resolveCheckpoint(cp: Checkpoint, unattended: boolean): CheckpointOutcome {
  // Decision 2 (LOCKED): a blocking-human auth/security gate NEVER auto-resolves
  // — even when unattended it HALTS and defers to end-of-phase human UAT.
  if (cp.gate === 'blocking-human') {
    return { action: 'halt', reason: 'blocking-human gate — defer to human UAT', continues: false };
  }
  // (a) Resolve deterministically if a resolver/criterion is available.
  if (cp.deterministicResolution != null) {
    return { action: 'resolve', via: 'deterministic', response: cp.deterministicResolution, continues: true };
  }
  // (b) Else take the declared fallback — but ONLY when unattended. Otherwise
  //     behave as today: pause/present to the human.
  if (unattended && cp.fallback != null) {
    return { action: 'resolve', via: 'fallback', response: cp.fallback, continues: true };
  }
  return { action: 'halt', reason: 'no deterministic resolution and a human is reachable', continues: false };
}

describe('auto-determination checkpoint policy (#25 gap 12 falsifier)', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = join(tmpdir(), `gsd-auto-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  // Assertion 1 — NO-HANG: unattended:true + non-security human checkpoint with
  // a declared fallback and no deterministic resolution → resolves to the safe
  // fallback and the phase CONTINUES (does not block/hang).
  it('unattended + non-security checkpoint with fallback → resolves to fallback and continues', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { unattended: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    const unattended = (data as { unattended: boolean }).unattended;
    expect(unattended).toBe(true);

    const cp: Checkpoint = {
      kind: 'human-verify',
      gate: 'blocking',
      deterministicResolution: null,
      fallback: 'refuse: leave feature behind a default-off flag',
    };
    const outcome = resolveCheckpoint(cp, unattended);
    expect(outcome.action).toBe('resolve');
    expect(outcome).toMatchObject({ via: 'fallback', continues: true });
    expect((outcome as { response: string }).response).toContain('refuse');
  });

  // Assertion 2 — AUTH GATE INVIOLABLE: unattended:true + gate="blocking-human"
  // → still HALTS / defers (is NOT auto-resolved).
  it('unattended + blocking-human gate → still HALTS, never auto-resolved', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { unattended: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    const unattended = (data as { unattended: boolean }).unattended;
    expect(unattended).toBe(true);

    const authGate: Checkpoint = {
      kind: 'human-action',
      gate: 'blocking-human',
      deterministicResolution: null,
      // Even WITH a fallback present, the auth gate must not auto-resolve.
      fallback: 'refuse',
    };
    const outcome = resolveCheckpoint(authGate, unattended);
    expect(outcome.action).toBe('halt');
    expect(outcome.continues).toBe(false);
  });

  // Assertion 3 — OPT-IN ONLY / NO REGRESSION: unattended:false (default) even
  // with auto_advance ON → a human checkpoint still pauses for the human
  // (auto-resolution does NOT fire; auto_advance is NOT the trust source).
  it('auto_advance:true but unattended:false → human checkpoint still HALTS', async () => {
    await writeFile(
      join(projectDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { auto_advance: true } }),
      'utf-8',
    );
    const { data } = await checkAutoMode([], projectDir);
    const d = data as { unattended: boolean; human_reachable: boolean; auto_advance: boolean };
    // auto_advance on, but unattended NOT proxied from it.
    expect(d.auto_advance).toBe(true);
    expect(d.unattended).toBe(false);
    expect(d.human_reachable).toBe(true);

    const cp: Checkpoint = {
      kind: 'human-verify',
      gate: 'blocking',
      deterministicResolution: null,
      fallback: 'refuse',
    };
    const outcome = resolveCheckpoint(cp, d.unattended);
    expect(outcome.action).toBe('halt');
    expect(outcome.continues).toBe(false);
  });
});
