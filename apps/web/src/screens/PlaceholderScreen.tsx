import { PHASES } from '../modules/roadmap';
import { Kbd } from '../ui/Kbd';
import { useServices, useSubscriptions } from '../shell/hooks';

/**
 * What a planned command shows until its feature exists. It is honest about that, and it proves the
 * path is real: you reached it through the Gateway, Go To or a shortcut, and Esc takes you back.
 */
export function PlaceholderScreen({ commandId }: { commandId: string }) {
  const { registry, keymapStore } = useServices();
  useSubscriptions(keymapStore);
  const command = registry.get(commandId);
  const phase = /^Phase (\d+)$/.exec(command?.badge ?? '')?.[1];
  const shortcut = keymapStore.keymap.chordsFor(commandId)[0];
  const back = keymapStore.keymap.chordsFor('app.back')[0];
  const goto = keymapStore.keymap.chordsFor('goto.open')[0];

  return (
    <section class="screen" aria-labelledby="planned-title" data-testid="planned-screen">
      <h1 id="planned-title">{command?.title ?? commandId}</h1>
      <p class="lede">{command?.category}</p>

      <div class="callout">
        <h2>Planned — not built yet</h2>
        {phase ? (
          <p>
            This arrives with <strong>Phase {phase}</strong>: {PHASES[Number(phase)]}.
          </p>
        ) : (
          <p>This feature is on the roadmap.</p>
        )}
        {shortcut && (
          <p>
            Its shortcut <Kbd chord={shortcut} /> is already reserved, so it will not change when the feature arrives.
          </p>
        )}
      </div>

      <p>
        {back && (
          <>
            Press <Kbd chord={back} /> to go back
          </>
        )}
        {goto && (
          <>
            {' '}
            or <Kbd chord={goto} /> to search for something else.
          </>
        )}
      </p>
    </section>
  );
}
