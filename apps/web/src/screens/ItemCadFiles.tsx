import { useEffect, useState } from 'preact/hooks';
import { useServices } from '../shell/hooks';
import type { ItemCadFileRow } from '../shell/services';
import { downloadText } from '../ui/download';
import { formatDate } from '../vouchers/format';

/**
 * A stock item's CAD files: the drawings MinimalCAD (the drawing application, its own site, the same sign-in) keeps on the item. Any
 * number, each with a name of its own. They are the same rows MinimalCAD's parts library opens and saves — nothing is copied — so a file
 * saved there is the one listed here. From here a file is opened in MinimalCAD, downloaded, or (while altering the item) added and
 * deleted; a deletion asks once more, because a deleted drawing is gone for good.
 *
 * They are not part of the item's own form: each change is made at once, not on accept. Online books only (the browser-only books have
 * no MinimalCAD to share them with).
 */
export function ItemCadFiles({ itemId, editable }: { readonly itemId: string; readonly editable: boolean }) {
  const { cadFiles, books: host } = useServices();
  const companyId = host.current?.companyId;
  const [files, setFiles] = useState<readonly ItemCadFileRow[] | undefined>(undefined);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | undefined>(undefined);
  const [deleting, setDeleting] = useState<string | undefined>(undefined);
  const [newName, setNewName] = useState('');

  const load = () => {
    if (!cadFiles || !companyId) return;
    void cadFiles.list(companyId, itemId).then((r) => (r.ok ? setFiles(r.value) : setNotice({ text: r.message, error: true })));
  };
  useEffect(load, [cadFiles, companyId, itemId]);

  if (!cadFiles || !companyId) return null;

  const said = (text: string, error = false) => setNotice({ text, error });
  const add = async (name: string, document: unknown) => {
    const trimmed = name.trim();
    if (trimmed === '') return said('Give the file a name', true);
    const r = await cadFiles.add(companyId, itemId, trimmed, document);
    if (!r.ok) return said(r.message, true);
    setNewName('');
    said(`${r.value.name} added.`);
    load();
  };
  const attach = async (file: File) => {
    let document: unknown;
    try {
      document = JSON.parse(await file.text());
    } catch {
      return said(`${file.name} is not a MinimalCAD drawing (.jcad)`, true);
    }
    if (typeof document !== 'object' || document === null || !Array.isArray((document as { entities?: unknown }).entities)) return said(`${file.name} is not a MinimalCAD drawing (.jcad)`, true);
    await add(newName.trim() || file.name.replace(/\.(jcad|json)$/i, ''), document);
  };
  const download = async (f: ItemCadFileRow) => {
    const r = await cadFiles.document(f.id);
    if (!r.ok) return said(r.message, true);
    downloadText(`${f.name}.jcad`, JSON.stringify(r.value, null, 2), 'application/json');
  };
  const remove = async (f: ItemCadFileRow) => {
    if (deleting !== f.id) return setDeleting(f.id);
    setDeleting(undefined);
    const r = await cadFiles.remove(companyId, f.id);
    if (!r.ok) return said(r.message, true);
    said(`${f.name} deleted.`);
    load();
  };

  return (
    <section class="item-cad-files" aria-label="CAD files" data-testid="item-cad-files">
      <h2 class="form-section">CAD files (MinimalCAD)</h2>
      {files === undefined ? (
        <p class="field-hint">Loading…</p>
      ) : files.length === 0 ? (
        <p class="field-hint">No CAD files on this item yet.{editable ? ' Add one below, or save a drawing onto it from MinimalCAD’s parts library.' : ''}</p>
      ) : (
        <ul class="item-file-list item-cad-list">
          {files.map((f) => (
            <li key={f.id} data-testid="item-cad-file">
              <span class="item-cad-name">{f.name}</span>
              <span class="field-hint">saved {formatDate(f.updatedAt.slice(0, 10))}</span>
              <a class="button" href={cadFiles.openUrl(f.id)} target="_blank" rel="noopener" data-testid="cad-open">
                Open in MinimalCAD ↗
              </a>
              <button type="button" class="button" onClick={() => void download(f)}>
                Download
              </button>
              {editable && (
                <button type="button" class="item-file-remove" data-testid="cad-delete" onClick={() => void remove(f)}>
                  {deleting === f.id ? 'Delete for good?' : 'Delete'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && (
        <div class="item-cad-add">
          <input class="field-input" aria-label="New CAD file name" placeholder="File name, e.g. Part or Drawing" value={newName} onInput={(e) => setNewName((e.target as HTMLInputElement).value)} />
          <button type="button" class="button" data-testid="cad-new" onClick={() => void add(newName, { entities: [], constraints: [] })}>
            New empty drawing
          </button>
          <label class="item-attach-file">
            Attach .jcad
            <input
              type="file"
              accept=".jcad,application/json"
              data-testid="cad-attach"
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const chosen = input.files?.[0];
                input.value = '';
                if (chosen) void attach(chosen);
              }}
            />
          </label>
        </div>
      )}
      {notice && (
        <p class={notice.error ? 'field-error' : 'field-hint'} role="status" data-testid="cad-notice">
          {notice.text}
        </p>
      )}
    </section>
  );
}
