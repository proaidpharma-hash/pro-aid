import { format, parseISO } from 'date-fns';

// Pakistani grouping: 1,04,350 · 29,84,600
export function rs(n: number | string | null | undefined, opts: { sign?: boolean; prefix?: boolean } = {}): string {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'string' ? Number(n) : n;
  if (Number.isNaN(v)) return '—';
  const neg = v < 0;
  const abs = Math.abs(Math.round(v));
  const s = String(abs);
  let out: string;
  if (s.length <= 3) out = s;
  else {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    out = `${rest},${last3}`;
  }
  const sign = neg ? '− ' : opts.sign ? '+ ' : '';
  return `${sign}${opts.prefix === false ? '' : 'Rs '}${out}`;
}
export const num = (n: number | string | null | undefined, sign = false) => rs(n, { prefix: false, sign });

export const today = () => format(new Date(), 'yyyy-MM-dd');
export const fmtDay = (d: string | Date, f = 'EEE d MMM yyyy') => format(typeof d === 'string' ? parseISO(d) : d, f);
export const fmtShort = (d: string | Date) => fmtDay(d, 'd MMM');
export const fmtTime = (d: string | Date) => format(typeof d === 'string' ? parseISO(d) : d, 'h:mm a');
export const fmtDateTime = (d: string | Date) => format(typeof d === 'string' ? parseISO(d) : d, 'd MMM h:mm a');
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
export const toNumber = (s: string) => { const v = Number(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(v) ? v : 0; };
