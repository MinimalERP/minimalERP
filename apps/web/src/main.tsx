// Composition root. The only place allowed to import adapters and wire services (see
// tooling/dependency-cruiser.cjs). It builds the command/keyboard services, chooses where the company lives, registers the
// modules, starts the ONE keyboard listener, and renders the shell.
//
// Where the company lives is decided by the build:
//   - built with VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (the GitHub Pages site): the books are ONLINE. Nothing renders until
//     someone has signed in (invitation only); the company is read from and written to Supabase through the `post-voucher` Edge Function.
//   - built with neither (development and the browser tests): the books live in this browser — a backend that enforces every rule,
//     saved to IndexedDB — and there is no sign-in.
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { SupabaseAuth, SupabaseBooksBackend, type SupabaseLike } from '@minimalerp/adapter-supabase';
import type { AuthSession } from '@minimalerp/ports';
import { render } from 'preact';
import { AuthScreen, StartupProblem } from './auth/AuthScreens';
import { type CloudConfig, cloudConfig, landingOf } from './auth/config';
import { BooksHost } from './books/books';
import { createCloudFactory } from './books/cloud';
import { indexedDbStore } from './books/idb';
import { createLocalFactory, memoryStore } from './books/local';
import { coreModule } from './modules/core';
import { mastersModule } from './modules/masters';
import { reportsModule } from './modules/reports';
import { roadmapModule } from './modules/roadmap';
import { vouchersModule } from './modules/vouchers';
import { ServicesContext } from './shell/hooks';
import { bindRouter } from './shell/router';
import { Shell } from './shell/Shell';
import { type Account, createServices } from './shell/services';
import './ui/tokens.css';
import './ui/shell.css';
import './ui/auth.css';

/** localStorage can throw (blocked, private windows); everything still works without it, just unsaved. */
function safeStorage(): Storage | undefined {
  try {
    const s = window.localStorage;
    s.getItem('minimalerp.probe');
    return s;
  } catch {
    return undefined;
  }
}

function root(): HTMLElement {
  const el = document.getElementById('app');
  if (!el) throw new Error('#app mount point missing from index.html');
  return el;
}

/** Shows the application for an open (or not yet created) company. Called once. */
function mountApp(books: BooksHost, account?: Account): void {
  const services = createServices({
    target: window,
    storage: safeStorage(),
    books,
    account,
    modules: [coreModule, roadmapModule, mastersModule, vouchersModule, reportsModule],
  });

  services.keyboard.start();
  bindRouter(services.screens, window);

  render(
    <ServicesContext.Provider value={services}>
      <Shell />
    </ServicesContext.Provider>,
    root(),
  );
}

/** The books live in this browser. */
async function startLocal(): Promise<void> {
  const books = new BooksHost(
    createLocalFactory({
      makeBackend: (masters) => new MemoryBackend(masters),
      store: indexedDbStore() ?? memoryStore(),
    }),
  );
  await books.restore();
  mountApp(books);
}

/** The address carries the invitation's tokens until the auth library has read them; after that they are only clutter (and the router reads the hash). */
function clearAuthHash(): void {
  if (/access_token|error/.test(window.location.hash)) window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/** The books live online, behind a sign-in. */
async function startCloud(config: CloudConfig): Promise<void> {
  const landing = landingOf(window.location.hash); // read BEFORE the auth library consumes and clears the address
  const { createClient } = await import('@supabase/supabase-js'); // not loaded at all when the books are local
  const client = createClient(config.url, config.anonKey);
  const auth = new SupabaseAuth(client, { redirectTo: new URL(import.meta.env.BASE_URL, window.location.origin).href });

  /** Signed in: open this account's books (or offer to create them), then show the app. */
  const enter = async (session: AuthSession): Promise<void> => {
    clearAuthHash();
    const factory = createCloudFactory({
      backend: new SupabaseBooksBackend(client as unknown as SupabaseLike),
      drafts: indexedDbStore(`minimalerp-drafts-${session.userId}`) ?? memoryStore(), // scratch work, per person, on this device
    });
    const host = new BooksHost(factory);
    try {
      host.adopt(await factory.restore());
    } catch (error) {
      console.error('Could not open the books', error);
      render(<StartupProblem title="Could not open your books" message="The server could not be reached. Check your connection and try again." onRetry={() => void enter(session)} />, root());
      return;
    }
    // Signed out elsewhere (another tab), or the session could not be renewed: back to the sign-in page rather than a dead app.
    auth.onChange((now) => {
      if (!now) window.location.reload();
    });
    mountApp(host, {
      email: session.email,
      signOut: async () => {
        await auth.signOut();
        window.location.reload();
      },
    });
  };

  const showSignIn = (signedInByLink: boolean): void => {
    clearAuthHash();
    render(<AuthScreen auth={auth} landing={landing} signedInByLink={signedInByLink} onSignedIn={(s) => void enter(s)} />, root());
  };

  const session = await auth.session(); // waits for the library to read an invitation link, if that is how the person came
  if (session && (landing.kind === 'invite' || landing.kind === 'recovery')) showSignIn(true); // signed in by the link; still needs a password
  else if (session) await enter(session);
  else showSignIn(false);
}

async function start(): Promise<void> {
  try {
    const config = cloudConfig(import.meta.env);
    await (config ? startCloud(config) : startLocal());
  } catch (error) {
    console.error(error);
    render(<StartupProblem title="MinimalERP could not start" message={error instanceof Error ? error.message : 'Something went wrong while starting.'} />, root());
  }
}

void start();
