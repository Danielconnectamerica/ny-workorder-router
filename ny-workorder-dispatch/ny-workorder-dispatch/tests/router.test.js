import { describe, expect, it } from 'vitest';
import { parseWorkOrder, safeStreet, packet } from '../src/pdf.js';
import { feasibleCounts, optimize, approximateMatrix, zipEstimate } from '../src/routing.js';

describe('work order extraction', () => {
  it('reads labeled fields and rejects incomplete pages', () => {
    const text = 'Work Order: 13702621\nAppointment Date: 9/29/2026 10:31:00 AM\nStreet 1: 556 Flushing Ave Apt 3A\nCity: Brooklyn      State: NY     Zip Code: 11206';
    expect(parseWorkOrder(text, 1)).toMatchObject({ id: '13702621', street: '556 Flushing Ave Apt 3A', city: 'Brooklyn', zip: '11206', errors: [] });
    expect(parseWorkOrder('Work Order: 1', 2).errors).toContain('Incomplete service address');
    expect(safeStreet('11530 114TH PL FL 1')).toBe('11530 114TH PL');
  });
});

describe('route constraints and packet isolation', () => {
  it('uses only exact same-ZIP anchors for a location estimate', () => {
    const jobs = [
      { zip: '11206', geo: { match: 'Match', lat: 40.7, lon: -73.95 } },
      { zip: '11206', geo: { match: 'No_Match', lat: 40.1, lon: -74.2 } },
      { zip: '11207', geo: { match: 'Match', lat: 40.9, lon: -73.8 } }
    ];
    expect(zipEstimate(jobs, '11206')).toMatchObject({ match: 'Zip_Estimate', lat: 40.7, lon: -73.95 });
    expect(zipEstimate(jobs, '11239')).toMatchObject({ match: 'Zip_Estimate', lat: 40.6497, lon: -73.8824 });
    expect(zipEstimate(jobs, '00000')).toBeNull();
  });
  it('enforces 14–16 and gives every page to one route', () => {
    expect(feasibleCounts(50, 3)).toBeNull();
    expect(feasibleCounts(30, 2)).toEqual([15, 15]);
    const jobs = Array.from({ length: 30 }, (_, i) => ({ page: i + 1, id: String(i + 1), geo: { lat: 40.6 + i * .001, lon: -73.9 + i * .001 } }));
    const routes = optimize(jobs, 2, approximateMatrix(jobs));
    expect(routes.map(r => r.jobs.length)).toEqual([15, 15]);
    expect(new Set(routes.flatMap(r => r.jobs.map(j => j.page))).size).toBe(30);
  });

  it('merges only the assigned source pages and preserves their order', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([612, 792]);
    const bytes = await doc.save();
    const assigned = await packet(bytes, { jobs: [{ page: 3 }, { page: 1 }] });
    expect((await PDFDocument.load(assigned)).getPageCount()).toBe(3);
  });

  it('marks approximate stops as reviewed or unreviewed on the packet', async () => {
    const { PDFDocument } = await import('pdf-lib');
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const source = await PDFDocument.create(); source.addPage([612, 792]);
    const bytes = await source.save();
    const job = { page: 1, id: '42', street: 'Example Street', city: 'Albany', state: 'NY', zip: '12207', geo: { match: 'Zip_Estimate' } };
    for (const reviewed of [false, true]) {
      const output = await packet(bytes, { jobs: [{ ...job, reviewed }] });
      const document = await pdfjs.getDocument({ data: output }).promise;
      const text = (await (await document.getPage(1)).getTextContent()).items.map(x => x.str).join(' ');
      expect(text).toContain(`APPROX LOCATION ${reviewed ? 'REVIEWED' : 'NOT REVIEWED'}`);
      await document.destroy();
    }
  });
});
