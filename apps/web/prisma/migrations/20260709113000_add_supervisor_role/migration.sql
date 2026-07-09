-- Additive role expansion for the operational middle tier.
-- No existing rows are changed: SUPERVISOR starts as an assignable enum value.
ALTER TYPE "UserRole" ADD VALUE 'SUPERVISOR';
