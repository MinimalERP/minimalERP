import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles } from './harness/testDb';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb(inject('pgPort'));
});
afterAll(async () => {
  await db?.close();
});

describe('migrations', () => {
  it('apply cleanly, in order, on an empty database', async () => {
    const tables = await db.pool.query(
      `select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'account_groups',
      'app_roles',
      'assistant_facts',
      'audit_log',
      'bill_allocations',
      'companies',
      'company_mail_scripts',
      'company_members',
      'company_print_layouts',
      'exchange_documents',
      'financial_years',
      'gst_rates',
      'inbox_items',
      'journal_lines',
      'ledgers',
      'numbering_series',
      'parties',
      'role_permissions',
      'search_index',
      'stock_groups',
      'stock_items',
      'stock_movements',
      'tasks',
      'units',
      'voucher_links',
      'voucher_revisions',
      'voucher_types',
      'vouchers',
      'warehouses',
      'website_enquiries',
      'website_enquiry_company',
    ]);
  });

  it('are named with sortable timestamps', () => {
    const names = migrationFiles().map((m) => m.name);
    expect(names).toEqual([...names].sort());
    expect(names.every((n) => /^\d{14}_[a-z0-9_]+\.sql$/.test(n))).toBe(true);
  });

  // Supabase's remote migration history is keyed by this 14-digit prefix alone, not the full file name: two files sharing one collide
  // there — the older one wins and the newer file is silently never applied — even though it applies fine here, where every file in the
  // directory is just run in order with nothing keyed by version.
  it('each have a timestamp no other migration uses', () => {
    const versions = migrationFiles().map((m) => m.name.slice(0, 14));
    const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  it('seed the four roles and their permissions', async () => {
    const perms = await db.pool.query(
      `select role, count(*)::int as n from role_permissions group by role order by role`,
    );
    const byRole = Object.fromEntries(perms.rows.map((r) => [r.role, r.n]));
    // owner: 3 read + 4 kinds*3 actions + company.admin + audit.view = 17, plus master.write and the 3 opening-balance
    // permissions (Phase 4) = 21. Accountant is the same without company.admin: 16 + 4 = 20. Phase 6a adds the Stock Journal and Opening
    // Stock kinds (3 actions each): owner 27, accountant 26, and a clerk may post stock journals: 7.
    // Phase 6b adds the Sales and Sales Order kinds the same way: owner 33, accountant 32, and a clerk may post both: 9.
    // Phase 8 adds the Purchase and Purchase Order kinds the same way: owner 39, accountant 38, and a clerk may post both: 11.
    // The AI Inbox (ADR-0023) lets owner and accountant send documents (inbox.submit): owner 40, accountant 39; and adds the `automation`
    // role of the Gmail add-on: it submits and reads (master, voucher, report) and posts nothing: 4.
    // Quotation adds three permissions for owner and accountant and clerk post: owner 43, accountant 42, clerk 12.
    // (minimalDASH added dash.view / dash.edit and was removed again: 20261015000100.)
    // The Delivery Challan adds three for owner, accountant and member, and clerk post: owner 46, accountant 45, member 45, clerk 13.
    // The Returnable Challan the same again: owner 49, accountant 48, member 48, clerk 14.
    // Tasks on the Gateway add task.write for owner, accountant, member and clerk: owner 50, accountant 49, member 49, clerk 15.
    // ADR-0025's member holds everything the owner does except company.admin.
    expect(byRole).toEqual({ accountant: 49, automation: 4, clerk: 15, member: 49, owner: 50, viewer: 3 });
  });
});
