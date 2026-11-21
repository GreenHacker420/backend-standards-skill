import { Router } from 'express';
import { makeCreateOrderAction } from './actions/create-order.action';
import { OrderOrchestrator } from './orchestrators/order-orchestrator';

/**
 * Orders Module Routes Factory
 * Injects dependencies (orchestrators) explicitly to guarantee production persistence.
 */
export function createOrdersRouter(orchestrator: OrderOrchestrator): Router {
  const router = Router();

  // Mount single-action controller with injected orchestrator
  router.post('/', makeCreateOrderAction(orchestrator));

  return router;
}
