import type { AuthGateway, AuthSession } from '@minimalerp/ports';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Landing, passwordProblem } from './config';

/**
 * What a person sees before they are signed in. There is no "create an account" here: the site is invite-only, so an account exists
 * because someone was invited, and the person arrives by the emailed link and chooses a password. Everything is reachable from the
 * keyboard: the first field has focus, Enter submits, and Tab reaches every button.
 */

type Mode = 'sign-in' | 'forgot' | 'set-password';

export interface AuthScreenProps {
  readonly auth: AuthGateway;
  /** How the person arrived (an invitation or reset link starts them at choosing a password). */
  readonly landing: Landing;
  /** True when the link has already signed them in and only the password is missing. */
  readonly signedInByLink: boolean;
  readonly onSignedIn: (session: AuthSession) => void;
}

export function AuthScreen({ auth, landing, signedInByLink, onSignedIn }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>(signedInByLink && (landing.kind === 'invite' || landing.kind === 'recovery') ? 'set-password' : 'sign-in');
  const [notice, setNotice] = useState<string | undefined>(landing.kind === 'error' ? landing.message : undefined);

  return (
    <main class="auth" aria-labelledby="auth-title">
      <div class="auth-card">
        <h1 id="auth-title">MinimalERP</h1>
        {mode === 'sign-in' && (
          <SignIn
            auth={auth}
            notice={notice}
            onSignedIn={onSignedIn}
            onForgot={() => {
              setNotice(undefined);
              setMode('forgot');
            }}
          />
        )}
        {mode === 'forgot' && (
          <Forgot
            auth={auth}
            onBack={() => {
              setNotice(undefined);
              setMode('sign-in');
            }}
          />
        )}
        {mode === 'set-password' && <SetPassword auth={auth} invited={landing.kind === 'invite'} onSignedIn={onSignedIn} />}
      </div>
    </main>
  );
}

/** Focuses the first field when a form appears. */
function useFocusFirst() {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return ref;
}

function Message({ text, kind }: { text: string | undefined; kind: 'error' | 'info' }) {
  // Always rendered, so a screen reader hears the change when it appears.
  return (
    <p class={kind === 'error' ? 'auth-message field-error' : 'auth-message'} role={kind === 'error' ? 'alert' : 'status'}>
      {text}
    </p>
  );
}

function SignIn({ auth, notice, onSignedIn, onForgot }: { auth: AuthGateway; notice: string | undefined; onSignedIn: (s: AuthSession) => void; onForgot: () => void }) {
  const first = useFocusFirst();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(notice);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (email.trim() === '' || password === '') return setError('Enter your email and password.');
    setBusy(true);
    setError(undefined);
    const r = await auth.signIn(email, password);
    if (r.ok) return onSignedIn(r.value);
    setBusy(false);
    setError(r.issues[0]?.message ?? 'Could not sign in.');
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Sign in">
      <p class="lede">Sign in to your books. This site is by invitation only.</p>
      <label for="auth-email">Email</label>
      <input id="auth-email" ref={first} class="field-input" type="email" autocomplete="username" spellcheck={false} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
      <label for="auth-password">Password</label>
      <input id="auth-password" class="field-input" type="password" autocomplete="current-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      <Message text={error} kind="error" />
      <div class="toolbar">
        <button type="submit" class="button" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" class="button link" onClick={onForgot}>
          Forgot password
        </button>
      </div>
    </form>
  );
}

function Forgot({ auth, onBack }: { auth: AuthGateway; onBack: () => void }) {
  const first = useFocusFirst();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (email.trim() === '') return setError('Enter your email.');
    setBusy(true);
    setError(undefined);
    const r = await auth.requestPasswordReset(email);
    setBusy(false);
    if (r.ok) setSent(true);
    else setError(r.issues[0]?.message ?? 'Could not send the email.');
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Reset password">
      <p class="lede">We will email you a link to choose a new password.</p>
      <label for="auth-reset-email">Email</label>
      <input id="auth-reset-email" ref={first} class="field-input" type="email" autocomplete="username" spellcheck={false} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
      {/* The same words whether or not the address is invited: nobody can find out who has an account. */}
      <Message text={sent ? 'If that email has an account, a link is on its way. Check your inbox.' : error} kind={sent ? 'info' : 'error'} />
      <div class="toolbar">
        <button type="submit" class="button" disabled={busy || sent}>
          Send link
        </button>
        <button type="button" class="button link" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}

function SetPassword({ auth, invited, onSignedIn }: { auth: AuthGateway; invited: boolean; onSignedIn: (s: AuthSession) => void }) {
  const first = useFocusFirst();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const submit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    const problem = passwordProblem(password, confirm);
    if (problem) return setError(problem);
    setBusy(true);
    setError(undefined);
    const r = await auth.setPassword(password);
    if (r.ok) return onSignedIn(r.value);
    setBusy(false);
    setError(r.issues[0]?.message ?? 'Could not save the password.');
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="Choose a password">
      <p class="lede">{invited ? 'Welcome. Choose a password to finish setting up your account.' : 'Choose a new password.'}</p>
      <label for="auth-new-password">New password</label>
      <input id="auth-new-password" ref={first} class="field-input" type="password" autocomplete="new-password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} />
      <label for="auth-confirm-password">Type it again</label>
      <input id="auth-confirm-password" class="field-input" type="password" autocomplete="new-password" value={confirm} onInput={(e) => setConfirm((e.target as HTMLInputElement).value)} />
      <Message text={error} kind="error" />
      <div class="toolbar">
        <button type="submit" class="button" disabled={busy}>
          {busy ? 'Saving…' : 'Save password and continue'}
        </button>
      </div>
    </form>
  );
}

/** Shown instead of the app when it cannot start (a bad build configuration, or the server cannot be reached to open the books). */
export function StartupProblem({ title, message, onRetry }: { title: string; message: string; onRetry?: (() => void) | undefined }) {
  return (
    <main class="auth" aria-labelledby="problem-title">
      <div class="auth-card">
        <h1 id="problem-title">{title}</h1>
        <p role="alert">{message}</p>
        {onRetry && (
          <div class="toolbar">
            <button type="button" class="button" onClick={onRetry} ref={(el) => el?.focus()}>
              Try again
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
