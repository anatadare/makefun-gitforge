// Determinism: every timestamp and generated id in a request path comes from here.
// The trial hands the entry MAKEFUN_TRIAL_NOW (an RFC 3339 UTC instant) and
// MAKEFUN_TRIAL_SEED (a decimal u64); both are fixed for a trial and identical
// between the live pass and the replay pass, so anything derived from them is
// deterministic. Nothing in this file reads the wall clock or Math.random.

// The scenario the suite runs against is fixed by the kit's public scenario
// seed, so the viewer (the token owner) is always the same user. These are
// that user's identity, used for the /user answer and for commits the server
// itself authors (contents writes, squash merges).
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_AVATAR_URL = 'https://example.invalid/avatar/adaiversen';

// Fallbacks when the trial env vars are absent (local smoke tests only).
const FALLBACK_NOW = '2026-01-01T00:00:00Z';

function rawTrialNow(): string {
  const value = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (value !== '' && !Number.isNaN(Date.parse(value))) return value;
  return FALLBACK_NOW;
}

// The trial instant never changes during a process, so parse and format it once.
let cachedIso: string | null = null;
let cachedEpochSec: number | null = null;

/** The trial instant as an ISO string with milliseconds, for created_at fields. */
export function trialNowIso(): string {
  if (cachedIso === null) cachedIso = new Date(rawTrialNow()).toISOString();
  return cachedIso;
}

/** The trial instant as epoch seconds, for git author/committer lines. */
export function trialNowEpochSec(): number {
  if (cachedEpochSec === null) cachedEpochSec = Math.floor(Date.parse(rawTrialNow()) / 1000);
  return cachedEpochSec;
}

/** The trial seed as a bigint (0 when absent). */
export function trialSeed(): bigint {
  try {
    return BigInt((process.env.MAKEFUN_TRIAL_SEED ?? '0').trim() || '0');
  } catch {
    return 0n;
  }
}

/** A tiny deterministic counter-based id source. Counters start from the trial
 *  seed so ids differ between trials but are stable within one. */
let counter = Number(trialSeed() % 1_000_000n);

export function nextCounter(): number {
  counter += 1;
  return counter;
}

/** Non-empty, unique-per-request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  return `req-${nextCounter().toString(16)}`;
}
