import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { createTicket } from '../orchestrators/ticket-orchestrator';

// 1. Inlined validation schema & inferred DTO
export const CreateTicketSchema = z.object({
    subject: z.string().min(3).max(255),
    description: z.string().optional().default(''),
    priority: z.enum(['low', 'medium', 'high']).default('low'),
    contactId: z.number().int().positive().optional(),
});
export type CreateTicketDTO = z.infer<typeof CreateTicketSchema>;

// 2. Action Controller: 1 File = 1 Action
export default async function createTicketController(req: Request, res: Response, next: NextFunction) {
    try {
        const parseResult = CreateTicketSchema.safeParse(req.body);
        if (!parseResult.success) {
            return res.status(400).json({
                error: true,
                message: parseResult.error.errors[0].message,
                invalidFormat: parseResult.error.format(),
            });
        }

        // 3. Guard Clause
        const user = (req as any).currentOrganizationUser;
        if (!user) {
            return res.status(401).json({ error: true, message: 'Unauthorized' });
        }

        // 4. Delegate to Domain Orchestrator
        const ticket = await createTicket({
            ...parseResult.data,
            organizationId: user.organizationId,
            createdByUserId: user.id,
            source: 'dashboard',
        });

        // 5. Standardized JSON response
        return res.status(201).json({
            success: true,
            message: 'Ticket created successfully',
            data: ticket,
        });
    } catch (error) {
        next(error);
    }
}
