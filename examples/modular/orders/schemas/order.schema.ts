import { z } from 'zod';

export const createOrderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().nonnegative()
});

export const createOrderSchema = z.object({
  customerId: z.string().uuid(),
  currency: z.string().length(3).default('USD'),
  items: z.array(createOrderItemSchema).min(1, 'Order must contain at least one item')
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderResponseSchema = z.object({
  id: z.string().uuid(),
  customerId: z.string().uuid(),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED']),
  totalCents: z.number().int(),
  currency: z.string(),
  createdAt: z.string().datetime()
});

export type OrderResponse = z.infer<typeof orderResponseSchema>;
