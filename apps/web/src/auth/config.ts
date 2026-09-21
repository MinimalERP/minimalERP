/**
 * Where the books live, and how a person arrived. Both are decided from the page's own environment before anything renders,
 * so they are plain functions of their inputs.
 */

export interface CloudConfig {
  readonly url: string;
  /** The project's public (anon) key. It is meant to ship in the page: what it may do is decided by the database, not by hiding it. */
  readonly anonKey: string;
  /** The project's own region (`ap-northeast-1`): the function is run there, next to the database, instead of at the edge nearest the caller. */
  readonly region?: string | undefined;
}

const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;

/**
 * The Supabase project the build was pointed at (`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`), or undefined when neither is set
 * (development and the browser tests, where the books live in the browser). One without the other is a mistake, and quietly running the
 * in-browser books in place of the online ones would be worse than stopping — so it throws, and the page says why.
 */
export function cloudConfig(env: Readonly<Record<string, unknown>>): CloudConfig | undefined {
  const url = typeof env['VITE_SUPABASE_URL'] === 'string' ? env['VITE_SUPABASE_URL'].trim() : '';
  const anonKey = typeof env['VITE_SUPABASE_ANON_KEY'] === 'string' ? env['VITE_SUPABASE_ANON_KEY'].trim() : '';
  if (url === '' && anonKey === '') return undefined;
  if (url === '' || anonKey === '') {
    throw new Error('The online books are half set up: VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must both be set, or neither.');
  }
  if (!url.startsWith('https://') && !LOCAL_HOST.test(url)) {
    throw new Error('VITE_SUPABASE_URL must be an https:// address (the project URL from the Supabase dashboard).');
  }
  const region = typeof env['VITE_SUPABASE_REGION'] === 'string' ? env['VITE_SUPABASE_REGION'].trim() : '';
  if (region !== '' && !/^[a-z]{2}-[a-z]+-[0-9]$/.test(region)) {
    throw new Error('VITE_SUPABASE_REGION must look like ap-northeast-1 (the project region from the Supabase dashboard), or be left out.');
  }
  return { url: url.replace(/\/+$/, ''), anonKey, ...(region !== '' ? { region } : {}) };
}

/** How the person reached the page, read from the address BEFORE the auth library consumes and clears it. */
export type Landing =
  /** An invitation link: they are signed in by it, and must choose a password. */
  | { readonly kind: 'invite' }
  /** A password-reset link: the same. */
  | { readonly kind: 'recovery' }
  /** A link that did not work (expired, already used). */
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'none' };

export function landingOf(hash: string): Landing {
  const params = new URLSearchParams(hash.replace(/^#\/?/, ''));
  const error = params.get('error_description') ?? (params.get('error') !== null ? 'This link did not work.' : null);
  if (error !== null) {
    const expired = params.get('error_code') === 'otp_expired';
    return { kind: 'error', message: expired ? 'This link has expired or was already used. Ask for a new one.' : error.replace(/\+/g, ' ') };
  }
  const type = params.get('type');
  if (params.has('access_token') && (type === 'invite' || type === 'recovery')) return { kind: type };
  return { kind: 'none' };
}

/** The smallest password we accept when someone sets one (the server enforces its own minimum too). */
export const MIN_PASSWORD = 8;

/** What is wrong with a password the person is choosing, or undefined if it is fine. */
export function passwordProblem(password: string, confirm: string): string | undefined {
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords are not the same.';
  return undefined;
}
