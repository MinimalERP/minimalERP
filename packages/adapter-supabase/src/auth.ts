import { type Result, fail, issue, ok } from '@minimalerp/domain';
import type { AuthGateway, AuthSession } from '@minimalerp/ports';
import type { SupabaseAuthLike, SupabaseAuthSession } from './client';

/** Not a domain rule: the sign-in request itself did not succeed. */
export const AUTH_FAILED = 'AUTH_FAILED';

/** What supabase-js says (by `code`) for the failures a person can do something about, in words for them. */
const FRIENDLY: Readonly<Record<string, string>> = {
  invalid_credentials: 'Wrong email or password.',
  email_not_confirmed: 'This email has not been confirmed yet. Open the invitation email and follow its link first.',
  over_request_rate_limit: 'Too many attempts. Wait a few minutes and try again.',
  over_email_send_rate_limit: 'Too many emails sent. Wait a few minutes and try again.',
  same_password: 'Choose a password different from the one you had.',
  session_not_found: 'This link has expired. Ask for a new one.',
  user_not_found: 'This link has expired. Ask for a new one.',
};

export interface SupabaseAuthOptions {
  /** Where the emailed reset link brings the person back to (must be on the project's redirect allow-list). */
  readonly redirectTo?: string | undefined;
}

const sessionOf = (s: SupabaseAuthSession | null | undefined): AuthSession | undefined =>
  s?.user ? { userId: s.user.id, email: s.user.email ?? '' } : undefined;

/**
 * The browser's AuthGateway: Supabase Auth with email and password. The session lives in supabase-js, which refreshes it.
 * There is no sign-up here on purpose — the project has public sign-up switched off and people are invited.
 */
export class SupabaseAuth implements AuthGateway {
  constructor(
    private readonly client: SupabaseAuthLike,
    private readonly options: SupabaseAuthOptions = {},
  ) {}

  async session(): Promise<AuthSession | undefined> {
    const { data, error } = await this.client.auth.getSession();
    return error ? undefined : sessionOf(data.session);
  }

  async signIn(email: string, password: string): Promise<Result<AuthSession>> {
    const { data, error } = await this.client.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return fail(this.problem(error));
    const session = sessionOf(data.session);
    return session ? ok(session) : fail(issue(AUTH_FAILED, 'Sign-in did not return a session. Try again.'));
  }

  async requestPasswordReset(email: string): Promise<Result<void>> {
    const { error } = await this.client.auth.resetPasswordForEmail(email.trim(), this.options.redirectTo ? { redirectTo: this.options.redirectTo } : undefined);
    // Whether or not the address has an account, the caller is told the same thing (nobody can probe who is invited).
    return error && error.code !== 'user_not_found' ? fail(this.problem(error)) : ok(undefined);
  }

  async setPassword(password: string): Promise<Result<AuthSession>> {
    const { data, error } = await this.client.auth.updateUser({ password });
    if (error) return fail(this.problem(error));
    const session = sessionOf(data.user ? { user: data.user } : null);
    return session ? ok(session) : fail(issue(AUTH_FAILED, 'This link has expired. Ask for a new one.'));
  }

  async signOut(): Promise<void> {
    await this.client.auth.signOut();
  }

  onChange(listener: (session: AuthSession | undefined) => void): () => void {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => listener(sessionOf(session)));
    return () => data.subscription.unsubscribe();
  }

  private problem(error: { readonly message: string; readonly code?: string | undefined }) {
    return issue(AUTH_FAILED, (error.code !== undefined ? FRIENDLY[error.code] : undefined) ?? error.message);
  }
}
