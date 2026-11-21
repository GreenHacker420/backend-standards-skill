import { z } from 'zod';

//? Security Invariant: Prices are NEVER accepted from client input!
//? Product prices must always be resolved server-side from authoritative catalog records.
export const createOrderItemSchema = z.object({
  productId: z.uuid('Product ID must be a valid UUID'),
  quantity: z.int('Quantity must be an integer').positive('Quantity must be at least 1').max(1000, 'Quantity cannot exceed 1000 per line item'),
});

//? Invariant: customerId is extracted from authenticated session context (req.currentOrganizationUser),
//? NEVER accepted from untrusted request body to prevent IDOR vulnerabilities.
export const createOrderSchema = z.object({
  currency: z.string().length(3, 'Currency must be an ISO-4217 3-letter code').default('USD'),
  items: z.array(createOrderItemSchema).min(1, 'Order must contain at least one item').max(100, 'Order cannot exceed 100 line items'),
});

export type CreateOrderItemInput = z.infer<typeof createOrderItemSchema>;
export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderItemResponseSchema = z.object({
  productId: z.uuid(),
  quantity: z.int().positive(),
  unitPriceCents: z.int().nonnegative(),
  lineTotalCents: z.int().nonnegative(),
});

export const orderResponseSchema = z.object({
  id: z.uuid(),
  organizationId: z.int().positive(),
  customerId: z.string().min(1),
  status: z.enum(['PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED']),
  items: z.array(orderItemResponseSchema),
  totalCents: z.int().nonnegative(),
  currency: z.string().length(3),
  createdAt: z.iso.datetime(),
});

export type OrderResponse = z.infer<typeof orderResponseSchema>;
