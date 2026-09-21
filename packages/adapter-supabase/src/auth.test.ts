import { describe, expect, it, vi } from 'vitest';
import { AUTH_FAILED, SupabaseAuth } from './auth';
import type { SupabaseAuthLike, SupabaseAuthSession } from './client';

const user = { id: 'u-1', email: 'owner@example.test' };
const session: SupabaseAuthSession = { user };

type Auth = SupabaseAuthLike['auth'];

/** A stand-in for `client.auth`: every method answers "fine" unless the test overrides it. */
function fakeClient(overrides: Partial<Auth> = {}) {
  const unsubscribe = vi.fn();
  const auth: Auth = {
    getSession: async () => ({ data: { session }, error: null }),
    signInWithPassword: async () => ({ data: { session }, error: null }),
    resetPasswordForEmail: async () => ({ error: null }),
    updateUser: async () => ({ data: { user }, error: null }),
    signOut: async () => ({ error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe } } }),
    ...overrides,
  };
  return { client: { auth } as SupabaseAuthLike, unsubscribe };
}

describe('SupabaseAuth', () => {
  it('session: who is signed in, or nobody (a failed lookup is "nobody", never a crash)', async () => {
    expect(await new SupabaseAuth(fakeClient().client).session()).toEqual({ userId: 'u-1', email: 'owner@example.test' });
    expect(await new SupabaseAuth(fakeClient({ getSession: async () => ({ data: { session: null }, error: null }) }).client).session()).toBeUndefined();
    expect(await new SupabaseAuth(fakeClient({ getSession: async () => ({ data: { session: null }, error: { message: 'boom' } }) }).client).session()).toBeUndefined();
  });

  describe('signIn', () => {
    it('trims the email (a pasted trailing space is not a wrong address) and returns the session', async () => {
      const signInWithPassword = vi.fn(async () => ({ data: { session }, error: null }));
      const r = await new SupabaseAuth(fakeClient({ signInWithPassword }).client).signIn('  owner@example.test ', 'pw');
      expect(signInWithPassword).toHaveBeenCalledWith({ email: 'owner@example.test', password: 'pw' });
      expect(r).toEqual({ ok: true, value: { userId: 'u-1', email: 'owner@example.test' } });
    });

    it.each([
      ['invalid_credentials', 'Wrong email or password.'],
      ['email_not_confirmed', /invitation email/],
      ['over_request_rate_limit', /Too many attempts/],
    ])('turns the server reason %s into words for the person', async (code, expected) => {
      const r = await new SupabaseAuth(
        fakeClient({ signInWithPassword: async () => ({ data: { session: null }, error: { message: 'raw', code } }) }).client,
      ).signIn('a@b.c', 'x');
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.issues[0]?.code).toBe(AUTH_FAILED);
        expect(r.issues[0]?.message).toMatch(expected);
        expect(r.issues[0]?.message).not.toBe('raw');
      }
    });

    it('passes an unknown failure through in the server’s own words rather than hiding it', async () => {
      const r = await new SupabaseAuth(
        fakeClient({ signInWithPassword: async () => ({ data: { session: null }, error: { message: 'Database error granting user' } }) }).client,
      ).signIn('a@b.c', 'x');
      expect(!r.ok && r.issues[0]?.message).toBe('Database error granting user');
    });

    it('a sign-in that answers with no session is a failure, not a success with nobody in it', async () => {
      const r = await new SupabaseAuth(fakeClient({ signInWithPassword: async () => ({ data: { session: null }, error: null }) }).client).signIn('a@b.c', 'x');
      expect(r.ok).toBe(false);
    });
  });

  describe('requestPasswordReset', () => {
    it('asks for the link to come back to the site, and succeeds', async () => {
      const resetPasswordForEmail = vi.fn(async () => ({ error: null }));
      const r = await new SupabaseAuth(fakeClient({ resetPasswordForEmail }).client, { redirectTo: 'https://x.test/app/' }).requestPasswordReset(' a@b.c ');
      expect(resetPasswordForEmail).toHaveBeenCalledWith('a@b.c', { redirectTo: 'https://x.test/app/' });
      expect(r.ok).toBe(true);
    });

    it('answers the same for an address with no account, so nobody can probe who is invited', async () => {
      const r = await new SupabaseAuth(
        fakeClient({ resetPasswordForEmail: async () => ({ error: { message: 'no such user', code: 'user_not_found' } }) }).client,
      ).requestPasswordReset('stranger@example.test');
      expect(r.ok).toBe(true);
    });

    it('but reports a real failure, such as the email limit', async () => {
      const r = await new SupabaseAuth(
        fakeClient({ resetPasswordForEmail: async () => ({ error: { message: 'x', code: 'over_email_send_rate_limit' } }) }).client,
      ).requestPasswordReset('a@b.c');
      expect(!r.ok && r.issues[0]?.message).toMatch(/Too many emails/);
    });
  });

  describe('setPassword (the person who came by an invitation or reset link)', () => {
    it('sends only the password and returns who it now belongs to', async () => {
      const updateUser = vi.fn(async () => ({ data: { user }, error: null }));
      const r = await new SupabaseAuth(fakeClient({ updateUser }).client).setPassword('a-good-password');
      expect(updateUser).toHaveBeenCalledWith({ password: 'a-good-password' });
      expect(r).toEqual({ ok: true, value: { userId: 'u-1', email: 'owner@example.test' } });
    });

    it('fails in words when the link has expired or the password repeats the old one', async () => {
      const expired = await new SupabaseAuth(fakeClient({ updateUser: async () => ({ data: { user: null }, error: null }) }).client).setPassword('pw12345678');
      expect(!expired.ok && expired.issues[0]?.message).toMatch(/expired/);
      const same = await new SupabaseAuth(fakeClient({ updateUser: async () => ({ data: { user: null }, error: { message: 'x', code: 'same_password' } }) }).client).setPassword('pw12345678');
      expect(!same.ok && same.issues[0]?.message).toMatch(/different/);
    });
  });

  it('onChange: reports the session as the app understands it, "nobody" on sign-out, and stops listening when asked', () => {
    let notify: (event: string, s: SupabaseAuthSession | null) => void = () => undefined;
    const { client, unsubscribe } = fakeClient({
      onAuthStateChange: (cb) => {
        notify = cb;
        return { data: { subscription: { unsubscribe } } };
      },
    });
    const seen: unknown[] = [];
    const stop = new SupabaseAuth(client).onChange((s) => seen.push(s));
    notify('SIGNED_IN', session);
    notify('SIGNED_OUT', null);
    expect(seen).toEqual([{ userId: 'u-1', email: 'owner@example.test' }, undefined]);
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('signOut asks the client to end the session', async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    await new SupabaseAuth(fakeClient({ signOut }).client).signOut();
    expect(signOut).toHaveBeenCalledOnce();
  });
});
