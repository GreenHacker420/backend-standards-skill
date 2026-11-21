import { Request, Response, NextFunction } from 'express';

//& Domain Boundary: Order Processing Action 🛒

/**
 * Single-action controller demonstrating:
 * 1. Semantic Commenting Grammar (//?, //!, //*)
 * 2. Guard Clauses & Early Returns (Zero deep nesting)
 * 3. Single Level of Abstraction Principle (SLAP)
 * 4. Advisory ~65-Line Controller Guideline (Transport only)
 * 5. Robust centralized error delegation via next(error)
 */
export async function createOrderAction(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // 1. Guard Clause: Authentication pre-condition
  if (!req.currentOrganizationUser) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }

  // 2. Guard Clause: Validation check
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ success: false, message: 'Order must contain at least one item' });
    return;
  }

  //? L1 in-memory check avoids a database roundtrip for active fraud-flagged accounts
  const isSuspended = req.currentOrganizationUser.organization?.customerType === 'SUSPENDED';
  if (isSuspended) {
    res.status(403).json({ success: false, message: 'Account is temporarily suspended' });
    return;
  }

  //* Business Rule: Non-working hours restrict immediate fulfillment; queue for next morning
  const timezone = req.currentOrganizationUser.timezone;

  //! Critical: Must wrap downstream call in try-catch to pass errors to global error middleware
  try {
    const order = await orderOrchestrator.placeOrder({
      organizationId: req.currentOrganizationUser.organizationId,
      userId: req.currentOrganizationUser.id,
      items,
      timezone,
    });

    res.status(201).json({
      success: true,
      data: order,
      meta: { traceId: req.traceId ?? 'unknown' }
    });
  } catch (error) {
    next(error);
  }
}

// Mock orchestrator interface for reference
const orderOrchestrator = {
  placeOrder: async (_input: { organizationId: number; userId: number; items: unknown[]; timezone?: string }) => ({
    id: 'ord_123',
    status: 'CONFIRMED'
  })
};
