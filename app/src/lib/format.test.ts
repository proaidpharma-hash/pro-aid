import { rs, num } from './format';
describe('Pakistani number formatting', () => {
  it('groups lakhs and crores', () => {
    expect(rs(940)).toBe('Rs 940');
    expect(rs(48250)).toBe('Rs 48,250');
    expect(rs(104350)).toBe('Rs 1,04,350');
    expect(rs(2984600)).toBe('Rs 29,84,600');
    expect(rs(12345678)).toBe('Rs 1,23,45,678');
  });
  it('handles sign and negatives', () => {
    expect(rs(-450)).toBe('− Rs 450');
    expect(rs(940, { sign: true })).toBe('+ Rs 940');
    expect(num(6020, true)).toBe('+ 6,020');
    expect(rs(null)).toBe('—');
    expect(rs('91350')).toBe('Rs 91,350');
  });
});
