import { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { createOrderSchema } from '../schemas/order.schema';
import { orderOrchestrator } from '../orchestrators/order-orchestrator';

/**
 * Single-action controller for creating a new customer order.
 * Route: POST /api/v1/orders
 * 
 * Enforces:
 * 1. Thin transport controller (< 65 lines advisory guideline)
 * 2. Strict authentication guard clauses (zero untrusted customerId in body)
 * 3. Authoritative server-side price resolution via Domain Orchestrator
 * 4. Standard REST envelope with Location header
 */
export async function createOrderAction(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // 1. Guard Clause: Authentication & multi-tenant identity verification
    const user = req.currentOrganizationUser;
    if (!user || !user.organizationId || !user.userId) {
      res.status(401).json({
        success: false,
        message: 'Unauthorized: active organization user session required.',
      });
      return;
    }

    // 2. Parse and validate untrusted input (items and currency only)
    const validatedInput = createOrderSchema.parse(req.body);
    const traceId = req.traceId ?? crypto.randomUUID();

    // 3. Delegate to Domain Orchestrator with authoritative context
    const order = await orderOrchestrator.createOrder(validatedInput, {
      organizationId: user.organizationId,
      customerId: user.userId.toString(),
      traceId,
    });

    // 4. Return standard 201 Created envelope with Location header
    res.setHeader('Location', `/api/v1/orders/${order.id}`);
    res.status(201).json({
      success: true,
      data: order,
      meta: {
        traceId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
}
