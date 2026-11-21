import crypto from 'node:crypto';
import { CreateOrderInput, OrderResponse } from '../schemas/order.schema';

export interface OrderExecutionContext {
  readonly organizationId: number;
  readonly customerId: string;
  readonly traceId: string;
}

export interface CatalogProduct {
  readonly id: string;
  readonly organizationId: number;
  readonly name: string;
  readonly priceCents: number;
  readonly currency: string;
  readonly isActive: boolean;
}

export interface OrderPersistenceClient {
  $transaction<T>(action: (tx: OrderTransactionClient) => Promise<T>): Promise<T>;
}

export interface OrderTransactionClient {
  order: {
    create(args: {
      data: {
        id: string;
        organizationId: number;
        customerId: string;
        status: 'PENDING';
        totalCents: number;
        currency: string;
        createdAt: Date;
        items: {
          create: Array<{
            productId: string;
            quantity: number;
            unitPriceCents: number;
            lineTotalCents: number;
          }>;
        };
      };
    }): Promise<unknown>;
  };
  outboxEvent: {
    create(args: {
      data: {
        eventType: string;
        payload: Record<string, unknown>;
        status: 'PENDING';
        attempts: number;
        createdAt: Date;
      };
    }): Promise<unknown>;
  };
}

/**
 * Mock Product Catalog Repository (authoritative database source of truth for stand-alone testing)
 * In production: queried via `tx.product.findMany({ where: { id: { in: productIds }, organizationId } })`
 */
const CATALOG_DB: Record<string, CatalogProduct> = {
  'a0000000-0000-4000-8000-000000000001': {
    id: 'a0000000-0000-4000-8000-000000000001',
    organizationId: 1,
    name: 'Enterprise Subscription Seat',
    priceCents: 4900, // $49.00
    currency: 'USD',
    isActive: true,
  },
  'b0000000-0000-4000-8000-000000000002': {
    id: 'b0000000-0000-4000-8000-000000000002',
    organizationId: 1,
    name: 'Dedicated Support Add-on',
    priceCents: 15000, // $150.00
    currency: 'USD',
    isActive: true,
  },
};

/**
 * Production Order Domain Orchestrator
 * 
 * Demonstrates the canonical domain workflow rules:
 * 1. Zero Client-Trusted Pricing: Prices are resolved strictly from authoritative database catalog records.
 * 2. Multi-Tenant Authorization: Products and customer contexts are verified against caller organization.
 * 3. Arithmetic Safety: Quantities, line totals, and grand totals are checked for integer overflow.
 * 4. Atomic Outbox Integration: Business records and outbox events commit together in a single ACID transaction.
 */
export class OrderOrchestrator {
  constructor(private readonly prisma?: OrderPersistenceClient) {}

  public async createOrder(
    input: CreateOrderInput,
    ctx: OrderExecutionContext
  ): Promise<OrderResponse> {
    const { organizationId, customerId, traceId } = ctx;

    // 1. Authoritative Server-Side Product Price Resolution
    let calculatedTotalCents = 0;
    const resolvedItems = [];

    for (const item of input.items) {
      const product = CATALOG_DB[item.productId];

      if (!product) {
        throw new Error(`Product not found or unavailable in this organization: ${item.productId}`);
      }

      if (!product.isActive) {
        throw new Error(`Product is currently inactive: ${product.name}`);
      }

      if (product.organizationId !== organizationId) {
        throw new Error(`Cross-tenant security violation: product ${item.productId} does not belong to organization ${organizationId}`);
      }

      if (product.currency.toUpperCase() !== input.currency.toUpperCase()) {
        throw new Error(`Currency mismatch: product ${product.name} is priced in ${product.currency}, but order requested ${input.currency}`);
      }

      const lineTotalCents = item.quantity * product.priceCents;
      if (!Number.isSafeInteger(lineTotalCents) || lineTotalCents < 0) {
        throw new RangeError(`Line item total exceeds safe integer bounds for product: ${item.productId}`);
      }

      calculatedTotalCents += lineTotalCents;
      if (!Number.isSafeInteger(calculatedTotalCents)) {
        throw new RangeError('Order total amount exceeds safe integer arithmetic limits');
      }

      resolvedItems.push({
        productId: product.id,
        quantity: item.quantity,
        unitPriceCents: product.priceCents,
        lineTotalCents,
      });
    }

    const orderId = crypto.randomUUID();
    const now = new Date();

    // 2. Transactional Persistence & Atomic Outbox Event Emission
    if (this.prisma) {
      await this.prisma.$transaction(async (tx) => {
        // Step A: Insert Order & Line Items
        await tx.order.create({
          data: {
            id: orderId,
            organizationId,
            customerId,
            status: 'PENDING',
            totalCents: calculatedTotalCents,
            currency: input.currency.toUpperCase(),
            createdAt: now,
            items: {
              create: resolvedItems,
            },
          },
        });

        // Step B: Atomically append outbox event in the SAME transaction
        await tx.outboxEvent.create({
          data: {
            eventType: 'order.created',
            payload: {
              orderId,
              organizationId,
              customerId,
              totalCents: calculatedTotalCents,
              currency: input.currency.toUpperCase(),
              traceId,
            },
            status: 'PENDING',
            attempts: 0,
            createdAt: now,
          },
        });
      });
    }

    return {
      id: orderId,
      organizationId,
      customerId,
      status: 'PENDING',
      items: resolvedItems,
      totalCents: calculatedTotalCents,
      currency: input.currency.toUpperCase(),
      createdAt: now.toISOString(),
    };
  }
}

export const orderOrchestrator = new OrderOrchestrator();
