import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { proofUrl } from './photos';
import { fmtDay } from './format';

export type PdfSection = { title: string; head?: string[]; rows: (string | number)[][] };

// A4 report: title, period, sections as tables, then the photos (one per row with its label).
export async function exportReportPdf(opts: { title: string; from: string; to: string; sections: PdfSection[]; photos?: { label: string; storagePath: string }[] }) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('Pro Aid', 40, 50);
  doc.setFontSize(13); doc.text(opts.title, 40, 72);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(107, 124, 122);
  doc.text(`${fmtDay(opts.from)} to ${fmtDay(opts.to)} · generated ${new Date().toLocaleString('en-GB')}`, 40, 88);
  doc.setTextColor(16, 32, 30);
  let y = 110;
  for (const s of opts.sections) {
    if (!s.rows.length) continue;
    if (y > 700) { doc.addPage(); y = 50; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(s.title, 40, y); y += 8;
    autoTable(doc, { startY: y, head: s.head ? [s.head] : undefined, body: s.rows.map((r) => r.map(String)), theme: 'grid', styles: { font: 'helvetica', fontSize: 9, cellPadding: 4, textColor: [16, 32, 30], lineColor: [225, 232, 231] }, headStyles: { fillColor: [15, 118, 110], textColor: 255, fontStyle: 'bold' }, columnStyles: Object.fromEntries(s.rows[0].map((_, i) => [i, i > 0 ? { halign: 'right' as const } : {}])), margin: { left: 40, right: 40 } });
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 22;
  }
  if (opts.photos?.length) {
    doc.addPage(); y = 50;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.text('Photos', 40, y); y += 16;
    for (const p of opts.photos.slice(0, 60)) {
      try {
        const url = await proofUrl(p.storagePath);
        const dataUrl = await toDataUrl(url);
        const img = await loadImage(dataUrl);
        const maxW = W - 80, maxH = 300;
        const scale = Math.min(maxW / img.width, maxH / img.height, 1);
        const w = img.width * scale, h = img.height * scale;
        if (y + h + 30 > 800) { doc.addPage(); y = 50; }
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(p.label, 40, y); y += 8;
        doc.addImage(dataUrl, 'JPEG', 40, y, w, h); y += h + 18;
      } catch { /* skip a photo that cannot be loaded */ }
    }
  }
  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(107, 124, 122); doc.text(`Pro Aid · page ${i} of ${total}`, W - 120, 820); }
  doc.save(`ProAid-${opts.title.replace(/\s+/g, '-')}-${opts.from}-${opts.to}.pdf`);
}

async function toDataUrl(url: string): Promise<string> {
  const r = await fetch(url); const b = await r.blob();
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result as string); fr.onerror = rej; fr.readAsDataURL(b); });
}
const loadImage = (src: string) => new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
