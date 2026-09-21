import type { UserBaseKind } from '@minimalerp/domain';

/** The voucher kinds that post to the accounts — what the accounting scenarios and properties are built from (a Stock Journal has no journal; the sales and purchase documents have their own contract). */
export type AccountingKind = Exclude<UserBaseKind, 'stockJournal' | 'sales' | 'salesOrder' | 'purchase' | 'purchaseOrder'>;
