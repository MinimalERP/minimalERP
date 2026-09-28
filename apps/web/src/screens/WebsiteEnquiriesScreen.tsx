import type { Frame } from '@minimalerp/command';
import { type WebsiteEnquiry, type WebsiteEnquiryList, type WebsiteEnquiryStatus, WEBSITE_ENQUIRY_STATUSES, sourceWords, telUrl, whatsappUrl } from '@minimalerp/domain';
import { useEffect, useState } from 'preact/hooks';
import { useCommandHandler, useFrameState, useListNavigation, useScope, useServices, useSubscriptions } from '../shell/hooks';
import type { ScreenRef } from '../shell/router';
import { ListView } from '../ui/ListView';
import { formatDate } from '../vouchers/format';

const SCOPE = 'screen:website-enquiries';
const DIALOG = 'overlay:website-enquiry';
const STATUS_WORDS: Readonly<Record<WebsiteEnquiryStatus, string>> = { new: 'New', contacted: 'Contacted', quoted: 'Quoted', won: 'Won', lost: 'Lost' };
type Filter = 'open' | WebsiteEnquiryStatus | 'all';
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'open', label: 'Open' },
  ...WEBSITE_ENQUIRY_STATUSES.map((s) => ({ value: s, label: STATUS_WORDS[s] })),
  { value: 'all', label: 'All' },
];
const isOpen = (s: WebsiteEnquiryStatus) => s === 'new' || s === 'contacted' || s === 'quoted';
/** "28-09-2026 14:05", in India. */
const when = (iso: string) => {
  const t = new Date(Date.parse(iso) + 330 * 60_000).toISOString();
  return `${formatDate(t.slice(0, 10))} ${t.slice(11, 16)}`;
};

/**
 * The quote enquiries from the company's website, newest first: who, how to reach them, what they want, from which page, and whether they
 * sent a drawing. Enter opens one: call, WhatsApp or write to them, download the drawing, move it new → contacted → quoted → won / lost,
 * put it on the Gateway as an enquiry to keep notes on, or delete it for good.
 */
export function WebsiteEnquiriesScreen({ frame }: { frame: Frame<ScreenRef> }) {
  const { books: host } = useServices();
  useSubscriptions(host);
  const books = host.current;
  const [list, setList] = useState<WebsiteEnquiryList | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [filter, setFilter] = useFrameState<Filter>(frame, 'filter', 'open');
  const [index, setIndex] = useFrameState(frame, 'index', 0);
  const [opened, setOpened] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!books) return;
    void host.websiteEnquiries().then((r) => (r.ok ? setList(r.value) : setError(r.issues.map((i) => i.message).join('; '))));
  }, [books?.companyId]);

  const rows = (list?.enquiries ?? []).filter((e) => (filter === 'all' ? true : filter === 'open' ? isOpen(e.status) : e.status === filter));
  const safeIndex = Math.min(index, Math.max(0, rows.length - 1));
  const open = (i: number) => setOpened(rows[i]?.id);
  useListNavigation(SCOPE, { index: safeIndex, count: rows.length, setIndex, onActivate: open });

  const change = async (c: unknown): Promise<string | undefined> => {
    const r = await host.applyWebsiteEnquiry(c as never);
    if (!r.ok) return r.issues[0]?.message ?? 'Not saved';
    setList(r.value);
    return undefined;
  };
  const shown = opened ? list?.enquiries.find((e) => e.id === opened) : undefined;
  const newCount = list?.enquiries.filter((e) => e.status === 'new').length ?? 0;

  return (
    <section class="screen" aria-labelledby="web-enq-title" data-testid="website-enquiries">
      <h1 id="web-enq-title">Website Enquiries</h1>
      <p class="lede">Quote requests sent from the website{newCount > 0 ? ` — ${newCount} new` : ''}. Enter opens one.</p>
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      {!list && !error && <p class="empty">Loading…</p>}
      {list && !list.site && <p class="empty">The website's enquiries belong to another of your companies.</p>}
      {list?.site && (
        <>
          <div class="chips" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.value} type="button" class={`button${filter === f.value ? ' primary' : ''}`} aria-pressed={filter === f.value} onClick={() => (setFilter(f.value), setIndex(0))}>
                {f.label} ({list.enquiries.filter((e) => (f.value === 'all' ? true : f.value === 'open' ? isOpen(e.status) : e.status === f.value)).length})
              </button>
            ))}
          </div>
          {rows.length === 0 && <p class="empty">None here.</p>}
          {rows.length > 0 && (
            <ListView
              items={rows}
              index={safeIndex}
              itemKey={(e) => e.id}
              label="Website enquiries"
              onActivate={open}
              renderItem={(e) => (
                <>
                  <span class="row-title">
                    {e.name} {e.drawing && <span title="Drawing attached">📎</span>}
                  </span>
                  <span class="row-desc" data-status={e.status}>
                    <strong>{STATUS_WORDS[e.status]}</strong> · {when(e.createdAt)} · {e.phone} · {e.email}
                    <br />
                    {e.requirement}
                    {(e.context || e.source) && ` — ${[e.context, sourceWords(e.source)].filter(Boolean).join(', ')}`}
                  </span>
                </>
              )}
            />
          )}
        </>
      )}
      {shown && <EnquiryDialog enquiry={shown} onChange={change} onClose={() => setOpened(undefined)} />}
    </section>
  );
}

/** One enquiry in full, with what can be done about it. */
function EnquiryDialog({ enquiry: e, onChange, onClose }: { enquiry: WebsiteEnquiry; onChange: (c: unknown) => Promise<string | undefined>; onClose: () => void }) {
  const { books: host, app } = useServices();
  useScope(DIALOG, 'overlay', true);
  useCommandHandler(DIALOG, 'app.back', () => (onClose(), true));
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  /** Delete asks once more: a deleted enquiry is gone from the database for good. */
  const [deleting, setDeleting] = useState(false);
  const wa = whatsappUrl(e.phone);
  const tel = telUrl(e.phone);
  const mail = `mailto:${encodeURIComponent(e.email)}?subject=${encodeURIComponent(`Your enquiry: ${e.context || e.requirement}`.slice(0, 120))}`;

  const setStatus = async (status: string) => setError(await onChange({ op: 'status', id: e.id, status }));
  const convert = async () => {
    const problem = await onChange({ op: 'convert', id: e.id });
    if (problem) return setError(problem);
    setNotice('Added to the Gateway’s enquiries.');
  };
  const remove = async () => {
    if (!deleting) return setDeleting(true);
    const problem = await onChange({ op: 'delete', id: e.id });
    if (problem) return setError(problem);
    onClose();
  };
  const drawing = async () => {
    const tab = window.open('', '_blank'); // opened now, while the click counts, so it is not blocked as a pop-up
    const r = await host.websiteDrawing(e.id);
    if (r.ok && r.value) {
      if (tab) tab.location.href = r.value;
      else window.location.assign(r.value);
    } else {
      tab?.close();
      setError(r.ok ? 'The drawing could not be fetched' : r.issues[0]?.message);
    }
  };

  return (
    <div class="overlay-backdrop">
      <div class="palette dialog task-dialog" role="dialog" aria-modal="true" aria-label={`Enquiry from ${e.name}`} data-testid="website-enquiry-dialog">
        <h2 class="dialog-title">Enquiry from {e.name}</h2>
        <div class="dialog-body">
          <p class="tasks-meta">
            {when(e.createdAt)}
            {e.source && ` · ${sourceWords(e.source)}`}
          </p>
          {e.context && (
            <p>
              <strong>{e.context}</strong>
            </p>
          )}
          <p style={{ whiteSpace: 'pre-wrap' }}>{e.requirement}</p>
          {[e.company && `Company: ${e.company}`, e.quantity && `Quantity: ${e.quantity}`, e.material && `Material: ${e.material}`, e.message].filter(Boolean).map((line, i) => (
            <p key={i}>{line}</p>
          ))}
          <p>
            {e.phone} · {e.email}
          </p>
          <div class="chips">
            {tel && (
              <a class="button" href={tel}>
                Call
              </a>
            )}
            {wa && (
              <a class="button" href={wa} target="_blank" rel="noopener">
                WhatsApp
              </a>
            )}
            <a class="button" href={mail}>
              Email
            </a>
            {e.drawing && (
              <button type="button" class="button" onClick={() => void drawing()}>
                Drawing ↓
              </button>
            )}
          </div>
          <label class="field-row">
            <span class="field-label">Status</span>
            <select class="field-input" value={e.status} onChange={(ev) => void setStatus((ev.target as HTMLSelectElement).value)} aria-label="Status">
              {WEBSITE_ENQUIRY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORDS[s]}
                </option>
              ))}
            </select>
          </label>
          {e.taskId ? (
            <p>
              On the Gateway’s enquiries{' '}
              <button type="button" class="link" onClick={() => (onClose(), app.navigate({ type: 'menu', id: 'gateway' }))}>
                open the Gateway
              </button>
            </p>
          ) : null}
          {notice && <p class="notice">{notice}</p>}
          {error && (
            <p class="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div class="palette-foot">
          <button type="button" class="button" data-testid="website-enquiry-delete" onClick={() => void remove()}>
            {deleting ? 'Delete for good?' : 'Delete'}
          </button>
          {!e.taskId && (
            <button type="button" class="button" data-testid="website-enquiry-convert" onClick={() => void convert()}>
              Convert to Gateway enquiry
            </button>
          )}
          <button type="button" class="button" onClick={onClose}>
            Close (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
