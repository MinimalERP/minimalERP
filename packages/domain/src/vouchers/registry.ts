import type { BaseKind } from '../masters/masters';
import type { VoucherKind } from './kind';
import { journalKind } from './kinds/journal';
import { openingKind } from './kinds/opening';
import { purchaseKind } from './kinds/purchase';
import { purchaseOrderKind } from './kinds/purchaseOrder';
import { salesKind } from './kinds/sales';
import { quotationKind } from './kinds/quotation';
import { salesOrderKind } from './kinds/salesOrder';
import { stockJournalKind } from './kinds/stockJournal';
import { stockOpeningKind } from './kinds/stockOpening';
import { contraKind, paymentKind, receiptKind } from './kinds/single-entry';

/** Instance-based (not a global singleton) so tests and modules can build isolated registries. */
export class VoucherKindRegistry {
  private readonly kinds = new Map<BaseKind, VoucherKind>();

  register(kind: VoucherKind): this {
    if (this.kinds.has(kind.base)) {
      throw new Error(`A voucher kind for "${kind.base}" is already registered`);
    }
    this.kinds.set(kind.base, kind);
    return this;
  }

  get(base: BaseKind): VoucherKind | undefined {
    return this.kinds.get(base);
  }

  list(): readonly VoucherKind[] {
    return [...this.kinds.values()];
  }
}

/** The kinds implemented so far. Each later phase registers its own (purchase, notes, quotations…). */
export function defaultVoucherKinds(): VoucherKindRegistry {
  return new VoucherKindRegistry()
    .register(contraKind)
    .register(paymentKind)
    .register(receiptKind)
    .register(journalKind)
    .register(openingKind)
    .register(stockJournalKind)
    .register(stockOpeningKind)
    .register(salesOrderKind)
    .register(quotationKind)
    .register(salesKind)
    .register(purchaseOrderKind)
    .register(purchaseKind);
}
