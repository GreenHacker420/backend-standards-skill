import { Prisma } from '@prisma/client';

/**
 * Type-Safe Prisma Query Projection Pattern
 * 
 * Production Invariant:
 * Never use loose handwritten DTOs (`interface UserDTO`) that easily drift from underlying SQL queries.
 * Instead, derive truthful compile-time return types directly from Prisma's generated query selection contract.
 * 
 * Prerequisites:
 * In your application project, define your schema in `prisma/schema.prisma` and run:
 * ```bash
 * npx prisma generate
 * ```
 * Prisma automatically generates the model `Select` interfaces (e.g. `Prisma.OrganizationUserSelect`)
 * and payload inference utilities (e.g. `Prisma.OrganizationUserGetPayload<T>`).
 */

// Model delegate types generated in application projects via `prisma generate`
declare module '@prisma/client' {
  namespace Prisma {
    export interface OrganizationUserSelect {
      id?: boolean;
      email?: boolean;
      firstName?: boolean;
      lastName?: boolean;
      organization?: boolean | {
        select?: {
          id?: boolean;
          codeName?: boolean;
          timezone?: boolean;
        };
      };
    }

    // Truly derives the resulting shape from the selection contract T
    export type OrganizationUserGetPayload<T extends { select?: OrganizationUserSelect }> = {
      id: number;
    } & (T['select'] extends { email: true } ? { email: string } : {})
      & (T['select'] extends { firstName: true } ? { firstName: string } : {})
      & (T['select'] extends { lastName: true } ? { lastName: string } : {})
      & (T['select'] extends { organization: { select: infer S } }
          ? {
              organization: (S extends { id: true } ? { id: number } : {})
                & (S extends { codeName: true } ? { codeName: string } : {})
                & (S extends { timezone: true } ? { timezone: string } : {});
            }
          : {});
  }
}

// 1. Declare projection using satisfies against Prisma's generated Select contract
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

// 2. Infer exact return type derived from the select contract
// If you remove 'email: true' from userWithOrgSelect above, UserWithOrgDTO instantly loses the 'email' property!
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
