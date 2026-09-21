import { describe, expect, it } from 'vitest';
import { cloudConfig, landingOf, passwordProblem } from './config';

describe('cloudConfig', () => {
  it('is undefined when neither variable is set (the in-browser books, for development and the browser tests)', () => {
    expect(cloudConfig({})).toBeUndefined();
    expect(cloudConfig({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '  ' })).toBeUndefined();
  });

  it('reads the project URL (without a trailing slash) and the anon key', () => {
    expect(cloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_ANON_KEY: ' key ' })).toEqual({
      url: 'https://abc.supabase.co',
      anonKey: 'key',
    });
  });

  it('refuses a half-configured build instead of quietly falling back to the in-browser books', () => {
    expect(() => cloudConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toThrow(/half set up/);
    expect(() => cloudConfig({ VITE_SUPABASE_ANON_KEY: 'key' })).toThrow(/half set up/);
  });

  it('accepts only https, or a local Supabase on this machine', () => {
    expect(() => cloudConfig({ VITE_SUPABASE_URL: 'http://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'k' })).toThrow(/https/);
    expect(cloudConfig({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'k' })?.url).toBe('http://127.0.0.1:54321');
    expect(() => cloudConfig({ VITE_SUPABASE_URL: 'http://localhost.evil.test', VITE_SUPABASE_ANON_KEY: 'k' })).toThrow(/https/);
  });
});

describe('landingOf', () => {
  it('knows an invitation link and a reset link, by the type Supabase puts in the address', () => {
    expect(landingOf('#access_token=a&refresh_token=r&type=invite')).toEqual({ kind: 'invite' });
    expect(landingOf('#access_token=a&refresh_token=r&type=recovery')).toEqual({ kind: 'recovery' });
  });

  it('does not treat a plain screen address, or a link of another kind, as either', () => {
    expect(landingOf('')).toEqual({ kind: 'none' });
    expect(landingOf('#/masters/ledgers')).toEqual({ kind: 'none' });
    expect(landingOf('#access_token=a&type=magiclink')).toEqual({ kind: 'none' });
    expect(landingOf('#type=invite')).toEqual({ kind: 'none' }); // no token: nobody was signed in by it
  });

  it('turns an expired link into words for the person', () => {
    const l = landingOf('#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(l).toEqual({ kind: 'error', message: 'This link has expired or was already used. Ask for a new one.' });
    expect(landingOf('#error=access_denied&error_description=Something+else+went+wrong')).toEqual({ kind: 'error', message: 'Something else went wrong' });
  });
});

describe('passwordProblem', () => {
  it('wants eight characters and the same thing twice', () => {
    expect(passwordProblem('short', 'short')).toMatch(/at least 8/);
    expect(passwordProblem('longenough', 'different1')).toMatch(/not the same/);
    expect(passwordProblem('longenough', 'longenough')).toBeUndefined();
  });
});
