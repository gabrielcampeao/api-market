import { PaymentStatus } from '@prisma/client';
import {
  canTransitionPayment,
  sourceStatusesFor,
  IMPOSSIBLE_PAYMENT_TRANSITIONS,
} from './payment-status.transitions';

const { PENDING, PROCESSING, APPROVED, FAILED, REFUNDED } = PaymentStatus;

// Hand-written, not derived from payment-status.transitions.ts — the point
// is to catch an accidental edit to that file, which a test that just
// re-imports and re-asserts the same table against itself never could.
const EXPECTED: Record<PaymentStatus, Record<PaymentStatus, boolean>> = {
  [PENDING]: { PENDING: false, PROCESSING: true, APPROVED: false, FAILED: false, REFUNDED: false },
  [PROCESSING]: { PENDING: true, PROCESSING: false, APPROVED: true, FAILED: true, REFUNDED: true },
  [APPROVED]: { PENDING: false, PROCESSING: false, APPROVED: false, FAILED: false, REFUNDED: true },
  [FAILED]: { PENDING: false, PROCESSING: true, APPROVED: false, FAILED: false, REFUNDED: false },
  [REFUNDED]: { PENDING: false, PROCESSING: false, APPROVED: false, FAILED: false, REFUNDED: false },
};

describe('payment-status.transitions', () => {
  it.each(Object.values(PaymentStatus))('matches the expected transition table for %s', (from) => {
    for (const to of Object.values(PaymentStatus)) {
      expect(canTransitionPayment(from, to)).toBe(EXPECTED[from][to]);
    }
  });

  it('rejects every transition the roadmap names as impossible', () => {
    expect(IMPOSSIBLE_PAYMENT_TRANSITIONS.length).toBeGreaterThan(0);
    for (const [from, to] of IMPOSSIBLE_PAYMENT_TRANSITIONS) {
      expect(canTransitionPayment(from, to)).toBe(false);
    }
  });

  it('rejects APPROVED -> PROCESSING specifically', () => {
    expect(canTransitionPayment(APPROVED, PROCESSING)).toBe(false);
  });

  it('rejects REFUNDED -> APPROVED specifically', () => {
    expect(canTransitionPayment(REFUNDED, APPROVED)).toBe(false);
  });

  it('allows every transition PaymentsService/reconciliation/webhook actually perform', () => {
    expect(canTransitionPayment(PENDING, PROCESSING)).toBe(true);
    expect(canTransitionPayment(FAILED, PROCESSING)).toBe(true);
    expect(canTransitionPayment(PROCESSING, PENDING)).toBe(true);
    expect(canTransitionPayment(PROCESSING, FAILED)).toBe(true);
    expect(canTransitionPayment(PROCESSING, APPROVED)).toBe(true);
    expect(canTransitionPayment(PROCESSING, REFUNDED)).toBe(true);
    expect(canTransitionPayment(APPROVED, REFUNDED)).toBe(true);
  });

  it('REFUNDED is fully terminal, APPROVED only transitions to REFUNDED', () => {
    expect(sourceStatusesFor(REFUNDED)).toEqual(expect.arrayContaining([PROCESSING, APPROVED]));
    for (const target of Object.values(PaymentStatus)) {
      expect(canTransitionPayment(REFUNDED, target)).toBe(false);
      expect(canTransitionPayment(APPROVED, target)).toBe((target as PaymentStatus) === REFUNDED);
    }
  });

  describe('sourceStatusesFor', () => {
    it('returns the exact set PaymentsService claims from for PROCESSING', () => {
      expect(sourceStatusesFor(PROCESSING).sort()).toEqual([FAILED, PENDING].sort());
    });

    it('returns an empty set for PENDING (nothing transitions back to it except PROCESSING reverting)', () => {
      expect(sourceStatusesFor(PENDING)).toEqual([PROCESSING]);
    });
  });
});
