import { IssueCode, deterministicUuid, localDate, seedCompany } from '@minimalerp/domain';
import { describe, expect, it } from 'vitest';
import { MemoryBackend } from './memoryBackend';

const newId = (n: string) => deterministicUuid(`mb|${n}`);

describe('MemoryBackend.sendDocument', () => {
  it('an `extraction` needs no reading: it is proposed and queued in the inbox directly', async () => {
    const masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const backend = new MemoryBackend(masters);
    const r = await backend.sendDocument(masters.company.id, {
      kind: 'sales',
      document: { extraction: { partyName: 'Acme Ltd', date: '2024-05-01', lines: [], bills: [] } },
      name: 'row-1',
    });
    expect(r.ok).toBe(true);
    const inbox = await backend.inbox(masters.company.id);
    expect(inbox.ok && inbox.value).toHaveLength(1);
    expect(inbox.ok && inbox.value[0]?.proposal.kind).toBe('sales');
    expect(inbox.ok && inbox.value[0]?.mailSubject).toBe('Uploaded: row-1');
  });

  it('a real document (not an extraction) still needs the online books', async () => {
    const masters = seedCompany({ name: 'T', fyStart: localDate('2024-04-01'), newId });
    const backend = new MemoryBackend(masters);
    const r = await backend.sendDocument(masters.company.id, { kind: 'sales', document: { mimeType: 'application/pdf', base64: 'abc' } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.issues[0]?.code).toBe(IssueCode.UnsupportedOperation);
  });
});
