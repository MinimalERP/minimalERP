import type { SupabaseLike } from './client';

/** One CAD file of a stock item (a MinimalCAD .jcad document), as the item form lists it. */
export interface ItemCadFile {
  readonly id: string;
  readonly name: string;
  /** When it was last saved (ISO timestamp) — from MinimalCAD or from here. */
  readonly updatedAt: string;
}

export type CadResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const FUNCTION = 'cad';

/**
 * A stock item's CAD files (migration 20261026000100_cad.sql): the same rows MinimalCAD's parts library opens and saves. Reads are
 * PostgREST under row-level security (the company's people); every change goes to the `cad` Edge Function, which checks the right to
 * change masters — the browser cannot write the table. Kept apart from the masters: a drawing can be megabytes, and is fetched only
 * when someone asks for it.
 */
export class SupabaseCadFiles {
  constructor(private readonly client: SupabaseLike) {}

  /** The item's files, by name (no drawings). */
  async list(companyId: string, itemId: string): Promise<CadResult<readonly ItemCadFile[]>> {
    const { data, error } = await this.client.from('item_cad_files').select('id, name, updated_at').eq('company_id', companyId).eq('item_id', itemId).order('name');
    if (error) return { ok: false, message: error.message };
    return { ok: true, value: (data ?? []).map((r) => ({ id: String(r['id']), name: String(r['name']), updatedAt: String(r['updated_at']) })) };
  }

  /** One file's drawing (to download it as a .jcad). */
  async document(id: string): Promise<CadResult<unknown>> {
    const { data, error } = await this.client.from('item_cad_files').select('document').eq('id', id);
    if (error) return { ok: false, message: error.message };
    const row = (data ?? [])[0];
    return row ? { ok: true, value: row['document'] } : { ok: false, message: 'That file is no longer on the item' };
  }

  /** A new file on the item (refused when it already has one of that name). */
  async add(companyId: string, itemId: string, name: string, document: unknown): Promise<CadResult<ItemCadFile>> {
    const r = await this.call({ action: 'item-file-save', companyId, itemId, name, document });
    if (!r.ok) return r;
    const v = r.value as { id: string; name: string; updated_at: string };
    return { ok: true, value: { id: v.id, name: v.name, updatedAt: v.updated_at } };
  }

  async remove(companyId: string, id: string): Promise<CadResult<void>> {
    const r = await this.call({ action: 'item-file-delete', companyId, id });
    return r.ok ? { ok: true, value: undefined } : r;
  }

  private async call(body: Record<string, unknown>): Promise<CadResult<unknown>> {
    try {
      const { data, error } = await this.client.functions.invoke(FUNCTION, { body });
      if (error) return { ok: false, message: error.message };
      const answer = data as { ok?: boolean; value?: unknown; message?: string } | null;
      return answer?.ok === true ? { ok: true, value: answer.value } : { ok: false, message: answer?.message ?? 'The server refused the change' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not reach the server' };
    }
  }
}
