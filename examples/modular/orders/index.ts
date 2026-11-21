/**
 * Public Module Contract for 'orders'
 * Other modules must ONLY import from this index file, never deep-linking internal files.
 */

export { ordersRouter } from './orders.routes';
export { orderOrchestrator } from './orchestrators/order-orchestrator';
export { CreateOrderInput, OrderResponse } from './schemas/order.schema';
