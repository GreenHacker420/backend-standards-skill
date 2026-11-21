import { Router } from 'express';
import { createOrderAction } from './actions/create-order.action';

export const ordersRouter = Router();

// Mount single-action controller
ordersRouter.post('/', createOrderAction);
