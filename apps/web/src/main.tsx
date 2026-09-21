// Composition root. The only place allowed to import adapters and wire services (see
// tooling/dependency-cruiser.cjs). It builds the command/keyboard services, chooses where the company lives
// (an in-browser backend saved to IndexedDB for now — Supabase plugs in here later), registers the modules,
// starts the ONE keyboard listener, and renders the shell.
import { MemoryBackend } from '@minimalerp/adapter-memory';
import { render } from 'preact';
import { BooksHost } from './books/books';
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
import { createServices } from './shell/services';
import './ui/tokens.css';
import './ui/shell.css';

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

async function start(): Promise<void> {
  // The company lives in this browser for now: a backend that enforces every rule, saved to IndexedDB (or held in
  // memory when the browser will not allow that). Swapping in a server-backed company is a change to this block only.
  const books = new BooksHost(
    createLocalFactory({
      makeBackend: (masters) => new MemoryBackend(masters),
      store: indexedDbStore() ?? memoryStore(),
    }),
  );
  await books.restore();

  const services = createServices({
    target: window,
    storage: safeStorage(),
    books,
    modules: [coreModule, roadmapModule, mastersModule, vouchersModule, reportsModule],
  });

  services.keyboard.start();
  bindRouter(services.screens, window);

  const root = document.getElementById('app');
  if (!root) throw new Error('#app mount point missing from index.html');
  render(
    <ServicesContext.Provider value={services}>
      <Shell />
    </ServicesContext.Provider>,
    root,
  );
}

void start();
