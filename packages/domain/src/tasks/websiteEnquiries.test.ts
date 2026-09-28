import { describe, expect, it } from 'vitest';
import { sourceWords, telUrl, websiteEnquiryCommandSchema, whatsappUrl } from './websiteEnquiries';

describe('website enquiries', () => {
  it('WhatsApp and calls reach an Indian number however it was typed', () => {
    for (const typed of ['98765 43210', '+91 98765-43210', '09876543210', '919876543210']) {
      expect(whatsappUrl(typed), typed).toBe('https://wa.me/919876543210');
      expect(telUrl(typed), typed).toBe('tel:+919876543210');
    }
  });

  it('a number that is not ten Indian digits gets no WhatsApp link, and is called as written', () => {
    expect(whatsappUrl('+44 20 7946 0958')).toBeUndefined();
    expect(telUrl('+44 20 7946 0958')).toBe('tel:+442079460958');
    expect(whatsappUrl('call me')).toBeUndefined();
    expect(telUrl('call me')).toBeUndefined();
  });

  it('says where on the website it was sent from', () => {
    expect(sourceWords('home')).toBe('Home page');
    expect(sourceWords('capability:machining/cnc-turning')).toBe('Capability: machining / cnc-turning');
    expect(sourceWords('tool:pipe-chart')).toBe('Tool: pipe-chart');
    expect(sourceWords(undefined)).toBe('');
  });

  it('a status is one of the five', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(websiteEnquiryCommandSchema.safeParse({ op: 'status', id, status: 'quoted' }).success).toBe(true);
    expect(websiteEnquiryCommandSchema.safeParse({ op: 'status', id, status: 'working' }).success).toBe(false);
  });
});
