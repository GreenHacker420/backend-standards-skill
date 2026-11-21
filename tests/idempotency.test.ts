import { describe, it, expect } from 'vitest';
import { canonicalize, computeRequestFingerprint } from '../examples/resilience/idempotency';
import type { Request } from 'express';

describe('Idempotency & Canonicalization', () => {
    it('canonicalizes nested objects deterministically regardless of key insertion order', () => {
        const objA = {
            b: 2,
            a: 1,
            nested: {
                z: 'last',
                y: 'middle',
                x: 'first',
                deep: { beta: true, alpha: false },
            },
        };

        const objB = {
            a: 1,
            nested: {
                deep: { alpha: false, beta: true },
                x: 'first',
                z: 'last',
                y: 'middle',
            },
            b: 2,
        };

        const canonicalA = JSON.stringify(canonicalize(objA));
        const canonicalB = JSON.stringify(canonicalize(objB));

        expect(canonicalA).toBe(canonicalB);
        expect(canonicalA).toBe('{"a":1,"b":2,"nested":{"deep":{"alpha":false,"beta":true},"x":"first","y":"middle","z":"last"}}');
    });

    it('computes identical SHA-256 fingerprints for equivalent requests', () => {
        const reqA = {
            method: 'POST',
            baseUrl: '/api/v1',
            path: '/orders/checkout',
            params: { orgId: '10' },
            query: { currency: 'USD', source: 'web' },
            body: { quantity: 2, productId: 'item_1' },
        } as unknown as Request;

        const reqB = {
            method: 'post',
            baseUrl: '/api/v1',
            path: '/orders/checkout',
            params: { orgId: '10' },
            query: { source: 'web', currency: 'USD' }, // reversed query keys
            body: { productId: 'item_1', quantity: 2 }, // reversed body keys
        } as unknown as Request;

        const fpA = computeRequestFingerprint(reqA);
        const fpB = computeRequestFingerprint(reqB);

        expect(fpA).toBe(fpB);
        expect(fpA).toHaveLength(64); // SHA-256 hex string
    });

    it('computes different fingerprints when operation inputs differ', () => {
        const reqA = {
            method: 'POST',
            baseUrl: '/api/v1',
            path: '/orders',
            params: {},
            query: {},
            body: { amount: 100 },
        } as unknown as Request;

        const reqB = {
            method: 'POST',
            baseUrl: '/api/v1',
            path: '/orders',
            params: {},
            query: {},
            body: { amount: 200 },
        } as unknown as Request;

        expect(computeRequestFingerprint(reqA)).not.toBe(computeRequestFingerprint(reqB));
    });
});
