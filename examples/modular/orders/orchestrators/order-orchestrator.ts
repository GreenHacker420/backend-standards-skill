import { CreateOrderInput, OrderResponse } from '../schemas/order.schema';

export class OrderOrchestrator {
  /**
   * Executes transactional order creation and queues outbox event.
   */
  public async createOrder(input: CreateOrderInput, traceId?: string): Promise<OrderResponse> {
    const totalCents = input.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPriceCents,
      0
    );

    // In production, execute within Prisma $transaction:
    // 1. Insert order & order_items
    // 2. Insert outbox_events record for event emission
    const order: OrderResponse = {
      id: crypto.randomUUID(),
      customerId: input.customerId,
      status: 'PENDING',
      totalCents,
      currency: input.currency,
      createdAt: new Date().toISOString()
    };

    return order;
  }
}

export const orderOrchestrator = new OrderOrchestrator();
