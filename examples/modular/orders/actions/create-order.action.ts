import { Request, Response, NextFunction } from 'express';
import { createOrderSchema } from '../schemas/order.schema';
import { orderOrchestrator } from '../orchestrators/order-orchestrator';

/**
 * Single-action controller for creating a new customer order.
 * Route: POST /api/v1/orders
 */
export async function createOrderAction(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const validatedInput = createOrderSchema.parse(req.body);
    const traceId = req.traceId ?? 'unknown';

    const order = await orderOrchestrator.createOrder(validatedInput, traceId);

    res.status(201).json({
      success: true,
      data: order,
      meta: {
        traceId,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
}
