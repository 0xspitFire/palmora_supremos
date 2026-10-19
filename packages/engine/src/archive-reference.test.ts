import { describe, expect, it } from 'vitest';

describe('archive reference boundaries', () => {
  it('binds Base only to its approved external store and leaves Robinhood unchanged', async () => {
    // Operational helpers are plain JavaScript and intentionally have no runtime package dependency.
    // @ts-expect-error the JavaScript helper has no declaration file
    const references = await import('../../../scripts/archive-reference.mjs') as {
      APPROVED_ARCHIVE_PATH: string;
      APPROVED_BASE_ARCHIVE_PATH: string;
      APPROVED_BASE_ARCHIVE_REFERENCE: string;
      parseArchiveReference: (source: string | undefined, key: string) => { filePath: string; key: string; display: string };
    };
    expect(references.parseArchiveReference(undefined, 'BASE_ARCHIVE_RPC')).toEqual({
      filePath: references.APPROVED_BASE_ARCHIVE_PATH,
      key: 'BASE_ARCHIVE_RPC',
      display: `${references.APPROVED_BASE_ARCHIVE_REFERENCE}:BASE_ARCHIVE_RPC`,
    });
    expect(() => references.parseArchiveReference(`${references.APPROVED_ARCHIVE_PATH}:BASE_ARCHIVE_RPC`, 'BASE_ARCHIVE_RPC')).toThrow('Base archive source must be');
    expect(references.parseArchiveReference(undefined, 'ROBINHOOD_ARCHIVE_RPC')).toMatchObject({
      filePath: references.APPROVED_ARCHIVE_PATH,
      key: 'ROBINHOOD_ARCHIVE_RPC',
    });
  });
});

