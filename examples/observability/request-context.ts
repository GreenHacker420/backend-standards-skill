import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
    traceId: string;
    requestId: string;
    spanId?: string;
    organizationId?: number;
    userId?: number;
    startTime: number;
}

class RequestContextStore {
    private storage = new AsyncLocalStorage<TraceContext>();

    public run(context: TraceContext, callback: () => void) {
        this.storage.run(context, callback);
    }

    public get(): TraceContext | undefined {
        return this.storage.getStore();
    }

    public getTraceId(): string {
        return this.storage.getStore()?.traceId || 'no-trace';
    }

    public getRequestId(): string {
        return this.storage.getStore()?.requestId || 'no-request-id';
    }
}

export const requestContext = new RequestContextStore();
