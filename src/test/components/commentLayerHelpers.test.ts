import { describe, it, expect } from 'vitest';
import { computeBottomSpacer } from '../../components/CommentLayer';

describe('computeBottomSpacer', () => {
  it('is 0 when every card already fits within the content', () => {
    // Lowest card bottom sits above the document content — no extra range needed.
    expect(computeBottomSpacer(400, 1000, 24)).toBe(0);
  });

  it('is 0 when the card bottom plus margin exactly meets the content', () => {
    expect(computeBottomSpacer(976, 1000, 24)).toBe(0);
  });

  it('extends by the overflow plus margin when a card runs past the content', () => {
    // 1200 + 24 - 1000 = 224
    expect(computeBottomSpacer(1200, 1000, 24)).toBe(224);
  });

  it('never returns a negative value', () => {
    expect(computeBottomSpacer(0, 1000, 24)).toBe(0);
    expect(computeBottomSpacer(100, 5000, 24)).toBe(0);
  });

  it('honors a custom margin', () => {
    expect(computeBottomSpacer(1000, 1000, 0)).toBe(0);
    expect(computeBottomSpacer(1000, 1000, 64)).toBe(64);
  });

  it('rounds to an integer', () => {
    expect(computeBottomSpacer(1200.4, 1000.1, 24)).toBe(224);
    expect(Number.isInteger(computeBottomSpacer(1200.7, 1000.3, 24.2))).toBe(true);
  });
});
