import { AsyncLocalStorage } from 'node:async_hooks';

export interface TraceContext {
    traceId: string;
    requestId: string;
    spanId?: string;
    parentId?: string;
    traceFlags?: string;
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

    public getSpanId(): string | undefined {
        return this.storage.getStore()?.spanId;
    }

    public getW3CTraceparent(): string | undefined {
        const ctx = this.storage.getStore();
        if (!ctx) return undefined;
        const spanId = ctx.spanId ?? '0000000000000001';
        const flags = ctx.traceFlags ?? '01';
        return `00-${ctx.traceId}-${spanId}-${flags}`;
    }
}

export const requestContext = new RequestContextStore();
