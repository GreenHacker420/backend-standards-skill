import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Type-Safe Prisma Query Projection Pattern
 * 
 * Production Invariant:
 * Never write manual TypeScript DTO interfaces (`interface UserDTO { ... }`) that easily drift
 * from database queries.
 * 
 * Instead, use Prisma's official generated `Select` contracts and `GetPayload` utilities.
 * Running `npx prisma generate` in your application analyzes `schema.prisma` and generates:
 * 1. `Prisma.<Model>Select`: Compile-time contract validating query selection shapes.
 * 2. `Prisma.<Model>GetPayload<{ select: typeof projection }>`: Automatically derives the exact
 *    compile-time return shape directly from the selection object.
 * 
 * Example Schema (`prisma/schema.prisma`):
 * ```prisma
 * model Organization {
 *   id        Int                @id @default(autoincrement())
 *   codeName  String             @unique
 *   timezone  String             @default("UTC")
 *   users     OrganizationUser[]
 * }
 * 
 * model OrganizationUser {
 *   id             Int          @id @default(autoincrement())
 *   email          String       @unique
 *   firstName      String
 *   lastName       String
 *   organizationId Int
 *   organization   Organization @relation(fields: [organizationId], references: [id])
 * }
 * ```
 */

// 1. Declare projection using `satisfies` against Prisma's official generated Select contract
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
} satisfies Prisma.OrganizationUserSelect;

// 2. Infer exact return type derived from Prisma's official generated GetPayload helper.
// If you add or remove fields in `userWithOrgSelect`, `UserWithOrgDTO` automatically updates at compile time!
export type UserWithOrgDTO = Prisma.OrganizationUserGetPayload<{
  select: typeof userWithOrgSelect;
}>;

/**
 * Example Service Function returning 100% truthful DTO
 */
export async function fetchUserWithOrg(
  prisma: PrismaClient,
  userId: number
): Promise<UserWithOrgDTO | null> {
  return prisma.organizationUser.findUnique({
    where: { id: userId },
    select: userWithOrgSelect,
  });
}
