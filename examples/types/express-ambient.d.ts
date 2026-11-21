// src/typings/express.d.ts
// Ambient namespace augmentation: extends Express types without requiring type assertions (as any)

export interface AuthenticatedUser {
    id: number;
    userId: number;
    organizationId: number;
    email: string;
    role: 'ADMIN' | 'MEMBER' | 'OWNER';
}

declare global {
    namespace Express {
        interface Request {
            traceId?: string;
            requestId?: string;
            currentOrganizationUser?: AuthenticatedUser;
        }

        interface Locals {
            abortSignal?: AbortSignal;
        }
    }
}

export {};
