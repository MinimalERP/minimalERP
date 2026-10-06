import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import { formatAmount } from '../vouchers/format';
import type { MobileNav } from './nav';

/** The few things every mobile page is made of: the frame with its title bar and Back, a row, a group of rows, a filter box. */

/** How long a finger rests on a row before it counts as a long press. */
export const HOLD_MS = 450;

export const rupees = (m: bigint): string => `₹ ${formatAmount(m < 0n ? -m : m)}${m < 0n ? ' Cr' : ''}`;

/** The frame every page sits in: a title bar with Back, then the page (and, when given, a bar that stays at the bottom, under the thumb). */
export function Frame({ nav, title, children, foot }: { nav: MobileNav; title: string; children: ComponentChildren; foot?: ComponentChildren }) {
  return (
    <>
      <header class="m-bar">
        {nav.depth > 1 ? (
          <button type="button" class="m-back" aria-label="Back" onClick={() => nav.back()}>
            ‹
          </button>
        ) : (
          <span class="m-back m-back-none" />
        )}
        <h1 class="m-title">{title}</h1>
      </header>
      <main class={foot ? 'm-main has-foot' : 'm-main'}>{children}</main>
      {foot ? <footer class="m-foot">{foot}</footer> : null}
    </>
  );
}

/** One row: what it is on the left, a figure (or nothing) on the right. Tappable when it opens something. */
export function Row({
  title,
  sub,
  value,
  note,
  tone,
  onOpen,
  onHold,
  selected,
  testId,
  problem,
}: {
  title: string;
  sub?: string | undefined;
  value?: string | undefined;
  note?: string | undefined;
  tone?: 'bad' | 'muted' | undefined;
  onOpen?: (() => void) | undefined;
  /** A long press on the row (the finger held still for half a second): how rows are chosen. The tap that ends it opens nothing. */
  onHold?: (() => void) | undefined;
  /** Chosen: ticked and tinted. */
  selected?: boolean | undefined;
  testId?: string;
  /** Said in red under the row: what is wrong with it. */
  problem?: string | undefined;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const release = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  const press = () => {
    held.current = false;
    release();
    timer.current = setTimeout(() => {
      held.current = true;
      onHold?.();
    }, HOLD_MS);
  };
  const body = (
    <>
      {selected ? (
        <span class="m-row-tick" aria-hidden="true">
          ✓
        </span>
      ) : null}
      <span class="m-row-text">
        <span class="m-row-title">{title}</span>
        {sub ? <span class="m-row-sub">{sub}</span> : null}
        {problem ? <span class="m-row-problem">{problem}</span> : null}
      </span>
      {value !== undefined || note ? (
        <span class="m-row-side">
          {value !== undefined ? <span class={`m-row-value${tone ? ` ${tone}` : ''}`}>{value}</span> : null}
          {note ? <span class={`m-row-sub${tone === 'bad' ? ' bad' : ''}`}>{note}</span> : null}
        </span>
      ) : null}
    </>
  );
  if (onHold) {
    // scrolling cancels the press (the browser takes the pointer); the phone's own long-press menu is not wanted on a row
    return (
      <button
        type="button"
        class={selected ? 'm-row selected' : 'm-row'}
        aria-pressed={selected === true}
        data-testid={testId}
        onPointerDown={press}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onContextMenu={(e) => e.preventDefault()}
        onClick={() => {
          if (held.current) held.current = false;
          else onOpen?.();
        }}
      >
        {body}
      </button>
    );
  }
  return onOpen ? (
    <button type="button" class="m-row" data-testid={testId} onClick={onOpen}>
      {body}
    </button>
  ) : (
    <div class="m-row" data-testid={testId}>
      {body}
    </div>
  );
}

export const Group = ({ title, children }: { title: string; children: ComponentChildren }) => (
  <section class="m-group">
    <h2 class="m-group-title">{title}</h2>
    {children}
  </section>
);

export const Empty = ({ children }: { children: ComponentChildren }) => <p class="m-empty">{children}</p>;

export function Search({ value, onInput, label, autoFocus }: { value: string; onInput: (v: string) => void; label: string; autoFocus?: boolean }) {
  return (
    <input
      class="m-search"
      type="search"
      inputMode="search"
      autocomplete="off"
      spellcheck={false}
      placeholder={label}
      aria-label={label}
      value={value}
      ref={(el) => {
        if (el && autoFocus && document.activeElement !== el && !el.dataset['focused']) {
          el.dataset['focused'] = '1';
          el.focus();
        }
      }}
      onInput={(e) => onInput((e.target as HTMLInputElement).value)}
    />
  );
}

export const matches = (text: string, ...fields: (string | undefined)[]): boolean => {
  const t = text.trim().toLowerCase();
  return t === '' || fields.some((f) => (f ?? '').toLowerCase().includes(t));
};
