-- The books: vouchers, journal lines, revisions, audit log.
--
-- The journal is the only source of financial truth. There is no balance column anywhere:
-- balances are always derived from journal_lines.

create table public.vouchers (
  id                 uuid primary key,          -- client-generated: doubles as the idempotency key
  company_id         uuid not null,
  voucher_type_id    uuid not null,
  financial_year_id  uuid not null,
  series_id          uuid not null,
  number             text not null,
  voucher_date       date not null,
  status             text not null check (status in ('posted', 'cancelled')),
  version            int  not null default 1 check (version >= 1),   -- optimistic-concurrency token
  revision           int  not null default 0 check (revision >= 0),  -- number of alterations
  content            jsonb not null,                                 -- the parsed draft as posted
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, series_id, number),
  constraint voucher_company_fk foreign key (company_id) references public.companies (id),
  constraint voucher_type_fk    foreign key (company_id, voucher_type_id)   references public.voucher_types (company_id, id),
  constraint voucher_fy_fk      foreign key (company_id, financial_year_id) references public.financial_years (company_id, id),
  constraint voucher_series_fk  foreign key (company_id, series_id)         references public.numbering_series (company_id, id)
);
create index vouchers_type_date_idx on public.vouchers (company_id, voucher_type_id, voucher_date);
create index vouchers_date_idx on public.vouchers (company_id, voucher_date);

create table public.journal_lines (
  id                 bigint generated always as identity primary key,
  company_id         uuid not null,
  voucher_id         uuid not null,
  line_no            int  not null check (line_no >= 1),
  entry_date         date not null,
  financial_year_id  uuid not null,
  ledger_id          uuid not null,
  debit              numeric(18, 2) not null default 0 check (debit >= 0),
  credit             numeric(18, 2) not null default 0 check (credit >= 0),
  narration          text,
  -- a line is a debit XOR a credit, and never zero
  constraint journal_one_side check ((debit > 0) <> (credit > 0)),
  unique (voucher_id, line_no),
  constraint line_voucher_fk foreign key (company_id, voucher_id)        references public.vouchers (company_id, id),
  constraint line_ledger_fk  foreign key (company_id, ledger_id)         references public.ledgers (company_id, id),
  constraint line_fy_fk      foreign key (company_id, financial_year_id) references public.financial_years (company_id, id)
);
-- ledger report / running balance (keyset paged) and day book
create index journal_ledger_idx on public.journal_lines (company_id, ledger_id, entry_date, voucher_id);
create index journal_date_idx   on public.journal_lines (company_id, entry_date, voucher_id);

-- Every prior state of an altered or cancelled voucher. Immutable (see 20260918000400).
create table public.voucher_revisions (
  id           bigint generated always as identity primary key,
  company_id   uuid not null,
  voucher_id   uuid not null,
  version      int  not null,                 -- the version this snapshot holds
  reason       text not null check (reason in ('alter', 'cancel')),
  snapshot     jsonb not null,                -- { voucher: {...}, journal: [...] }
  replaced_by  uuid,
  replaced_at  timestamptz not null default now(),
  constraint revision_voucher_fk foreign key (company_id, voucher_id) references public.vouchers (company_id, id)
);
create index voucher_revisions_voucher_idx on public.voucher_revisions (voucher_id, id);

-- Append-only audit trail (see 20260918000400).
create table public.audit_log (
  id           bigint generated always as identity primary key,
  company_id   uuid not null references public.companies (id),
  actor        uuid,
  action       text not null,
  entity_type  text not null,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  request_id   text,
  at           timestamptz not null default now()
);
create index audit_log_company_idx on public.audit_log (company_id, id);
create index audit_log_entity_idx  on public.audit_log (entity_type, entity_id);
