import { describe, expect, it } from 'vitest';
import { SupabaseCadFiles } from './cadFiles';
import type { FilterBuilder, InvokeResult, QueryResult, SupabaseLike } from './client';

/** A client that answers every read with `rows` and records what was asked of it. */
function fake(rows: QueryResult, invoke: InvokeResult = { data: { ok: true, value: {} }, error: null }) {
  const asked: { table?: string; columns?: string; filters: [string, unknown][]; invoked: { name: string; body: Record<string, unknown> }[] } = { filters: [], invoked: [] };
  const builder: FilterBuilder = {
    eq(column, value) {
      asked.filters.push([column, value]);
      return builder;
    },
    gte: () => builder,
    lte: () => builder,
    order: () => builder,
    range: () => builder,
    then: (ok, bad) => Promise.resolve(rows).then(ok, bad),
  };
  const client: SupabaseLike = {
    from(table) {
      asked.table = table;
      return {
        select(columns) {
          asked.columns = columns;
          return builder;
        },
      };
    },
    functions: {
      invoke: async (name, options) => {
        asked.invoked.push({ name, body: options.body });
        return invoke;
      },
    },
  };
  return { client, asked };
}

describe('a stock item’s CAD files', () => {
  it('lists the item’s files by reading the table (row-level security decides), without their drawings', async () => {
    const { client, asked } = fake({ data: [{ id: 'f1', name: 'Part', updated_at: '2026-10-06T05:00:00Z' }], error: null });
    const r = await new SupabaseCadFiles(client).list('co', 'item');
    expect(r).toEqual({ ok: true, value: [{ id: 'f1', name: 'Part', updatedAt: '2026-10-06T05:00:00Z' }] });
    expect(asked.table).toBe('item_cad_files');
    expect(asked.columns).not.toContain('document');
    expect(asked.filters).toEqual([['company_id', 'co'], ['item_id', 'item']]);
  });

  it('fetches one drawing to download; says so when the file is gone', async () => {
    expect(await new SupabaseCadFiles(fake({ data: [{ document: { entities: [] } }], error: null }).client).document('f1')).toEqual({ ok: true, value: { entities: [] } });
    expect((await new SupabaseCadFiles(fake({ data: [], error: null }).client).document('f1')).ok).toBe(false);
  });

  it('adds and deletes through the cad function, never by writing the table', async () => {
    const { client, asked } = fake({ data: [], error: null }, { data: { ok: true, value: { id: 'f2', name: 'Drawing', updated_at: 't' } }, error: null });
    const files = new SupabaseCadFiles(client);
    expect(await files.add('co', 'item', 'Drawing', { entities: [] })).toEqual({ ok: true, value: { id: 'f2', name: 'Drawing', updatedAt: 't' } });
    expect(await files.remove('co', 'f2')).toEqual({ ok: true, value: undefined });
    expect(asked.invoked).toEqual([
      { name: 'cad', body: { action: 'item-file-save', companyId: 'co', itemId: 'item', name: 'Drawing', document: { entities: [] } } },
      { name: 'cad', body: { action: 'item-file-delete', companyId: 'co', id: 'f2' } },
    ]);
  });

  it('a refusal is the server’s own sentence; a read error is passed on', async () => {
    const refused = fake({ data: [], error: null }, { data: { ok: false, message: 'This item already has a file named "Part"' }, error: null });
    expect(await new SupabaseCadFiles(refused.client).add('co', 'item', 'Part', {})).toEqual({ ok: false, message: 'This item already has a file named "Part"' });
    expect(await new SupabaseCadFiles(fake({ data: null, error: { message: 'network down' } }).client).list('co', 'item')).toEqual({ ok: false, message: 'network down' });
  });
});
