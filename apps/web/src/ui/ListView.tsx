import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

export interface ListViewProps<T> {
  readonly items: readonly T[];
  /** The cursor row. Owned by the caller; keyboard movement changes it through commands, not here. */
  readonly index: number;
  readonly itemKey: (item: T) => string;
  readonly renderItem: (item: T, selected: boolean) => ComponentChildren;
  /** Mouse: clicking a row activates it (keyboard activation goes through the nav.activate command). */
  readonly onActivate: (index: number) => void;
  readonly label: string;
  /** Gives each row an id (`prefix-0`, `prefix-1`…) for aria-activedescendant. */
  readonly idPrefix?: string;
  readonly class?: string;
}

/**
 * A selectable list. It draws the cursor and keeps it scrolled into view — and nothing else.
 * It has no key handling of its own: movement and activation are commands handled by the screen.
 */
export function ListView<T>(props: ListViewProps<T>) {
  const ref = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const row = ref.current?.children[props.index];
    if (row && 'scrollIntoView' in row) (row as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [props.index, props.items.length]);

  return (
    <ul ref={ref} class={`list ${props.class ?? ''}`} role="listbox" aria-label={props.label}>
      {props.items.map((item, i) => {
        const selected = i === props.index;
        return (
          <li
            key={props.itemKey(item)}
            class={selected ? 'list-row selected' : 'list-row'}
            role="option"
            id={props.idPrefix ? `${props.idPrefix}-${i}` : undefined}
            aria-selected={selected}
            onClick={() => props.onActivate(i)}
          >
            {props.renderItem(item, selected)}
          </li>
        );
      })}
    </ul>
  );
}
