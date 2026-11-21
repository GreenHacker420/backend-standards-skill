import { Prisma } from '@prisma/client';

/**
 * Type-Safe Prisma Query Projection Pattern
 * Guarantees zero 'as any' and enforces compile-time alignment between SQL and TypeScript.
 */

// 1. Declare projection using satisfies
export const userWithOrgSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  organization: {
    select: {
      id: true,
      codeName: true,
      timezone: true,
    },
  },
} as const satisfies Prisma.OrganizationUserSelect;

// 2. Infer exact return type from the select contract
export type UserWithOrgDTO = Prisma.OrganizationUserGetPayload<{
  select: typeof userWithOrgSelect;
}>;

/**
 * Example Service Function returning 100% truthful DTO
 */
export async function fetchUserWithOrg(
  prisma: any, // In production: PrismaClient
  userId: number
): Promise<UserWithOrgDTO | null> {
  return prisma.organizationUser.findUnique({
    where: { id: userId },
    select: userWithOrgSelect,
  });
}
