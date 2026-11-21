import { describe, it, expect } from 'vitest';
import { parseUserId, parseOrderId, parseEmail } from '../examples/types/branded-types';
import { Money } from '../examples/types/smart-constructors';

describe('Type Safety & Smart Constructors', () => {
    describe('Branded Types Parsers', () => {
        it('validates and brands valid user IDs', () => {
            const res = parseUserId(42);
            expect(res.ok).toBe(true);
            if (res.ok) expect(res.data).toBe(42);
        });

        it('rejects invalid or unsafe user IDs', () => {
            expect(parseUserId(-1).ok).toBe(false);
            expect(parseUserId(0).ok).toBe(false);
            expect(parseUserId(1.5).ok).toBe(false);
            expect(parseUserId('42').ok).toBe(false);
            expect(parseUserId(Number.MAX_SAFE_INTEGER + 10).ok).toBe(false);
        });

        it('validates RFC-compliant email formats via Zod v4', () => {
            const valid = parseEmail('Dev.Engineer+test@example.com');
            expect(valid.ok).toBe(true);
            if (valid.ok) expect(valid.data).toBe('dev.engineer+test@example.com');

            expect(parseEmail('not-an-email').ok).toBe(false);
            expect(parseEmail('').ok).toBe(false);
            expect(parseEmail(null).ok).toBe(false);
        });
    });

    describe('Money Value Object', () => {
        it('creates valid money amounts in minor units', () => {
            const money = Money.create(5000, 'USD');
            expect(money.ok).toBe(true);
            if (money.ok) {
                expect(money.data.amountCents).toBe(5000);
                expect(money.data.currency).toBe('USD');
                expect(money.data.format()).toBe('50.00 USD');
            }
        });

        it('rejects negative or floating point cents', () => {
            expect(Money.create(-100, 'USD').ok).toBe(false);
            expect(Money.create(10.5, 'USD').ok).toBe(false);
            expect(Money.create(NaN, 'USD').ok).toBe(false);
        });

        it('adds money of identical currency and protects against integer overflow', () => {
            const m1 = Money.create(1000, 'USD');
            const m2 = Money.create(2500, 'USD');
            const m3 = Money.create(1000, 'EUR');

            if (m1.ok && m2.ok && m3.ok) {
                const sum = m1.data.add(m2.data);
                expect(sum.ok).toBe(true);
                if (sum.ok) expect(sum.data.amountCents).toBe(3500);

                // Currency mismatch
                const mismatch = m1.data.add(m3.data);
                expect(mismatch.ok).toBe(false);

                // Overflow protection
                const nearMax = Money.create(Number.MAX_SAFE_INTEGER - 10, 'USD');
                if (nearMax.ok) {
                    const overflow = nearMax.data.add(m1.data);
                    expect(overflow.ok).toBe(false);
                }
            }
        });

        it('subtracts money and prevents negative balances', () => {
            const m1 = Money.create(5000, 'USD');
            const m2 = Money.create(2000, 'USD');
            const m3 = Money.create(6000, 'USD');

            if (m1.ok && m2.ok && m3.ok) {
                const res = m1.data.subtract(m2.data);
                expect(res.ok).toBe(true);
                if (res.ok) expect(res.data.amountCents).toBe(3000);

                // Insufficient funds
                const overdraft = m1.data.subtract(m3.data);
                expect(overdraft.ok).toBe(false);
            }
        });
    });
});
