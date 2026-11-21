/**
 * Public Module Contract for 'orders'
 * Other modules must ONLY import from this index file, never deep-linking internal files.
 */

export { createOrdersRouter } from './orders.routes';
export {
  OrderOrchestrator,
  createOrderOrchestrator,
  createMockOrderPersistenceClient,
  MOCK_CATALOG_FIXTURE,
  OrderResponse,
  OrderPersistenceClient,
} from './orchestrators/order-orchestrator';
export { CreateOrderInput, createOrderSchema } from './schemas/order.schema';
