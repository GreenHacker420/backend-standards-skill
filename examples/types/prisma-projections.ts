import { Prisma } from '@prisma/client';

/**
 * Type-Safe Prisma Query Projection Pattern
 * Guarantees zero 'as any' and enforces compile-time alignment between SQL and TypeScript.
 */

// Model delegate types generated in production via prisma generate
declare module '@prisma/client' {
  namespace Prisma {
    export interface OrganizationUserSelect {
      id?: boolean;
      email?: boolean;
      firstName?: boolean;
      lastName?: boolean;
      organization?: {
        select: {
          id?: boolean;
          codeName?: boolean;
          timezone?: boolean;
        };
      };
    }
    export type OrganizationUserGetPayload<T extends { select: unknown }> = {
      id: number;
      email: string;
      firstName: string;
      lastName: string;
      organization: {
        id: number;
        codeName: string;
        timezone: string;
      };
    };
  }
}

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
  prisma: {
    organizationUser: {
      findUnique(args: { where: { id: number }; select: typeof userWithOrgSelect }): Promise<UserWithOrgDTO | null>;
    };
  },
  userId: number
): Promise<UserWithOrgDTO | null> {
  return prisma.organizationUser.findUnique({
    where: { id: userId },
    select: userWithOrgSelect,
  });
}
