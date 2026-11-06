export const PERMISSIONS = [
  'subscribers.read',
  'subscribers.write',
  'subscribers.delete',
  'subscribers.kick',
  'subscribers.password.reveal',
  'subscribers.export',
  'sessions.read',
  'nas.read',
  'nas.write',
  'plans.read',
  'plans.write',
  'resellers.read',
  'resellers.write',
  'wallets.transfer',
  'wallets.refund',
  'wallets.adjust',
  'billing.cash',
  'reports.view',
  'imports.run',
  'users.read',
  'users.write',
  'roles.write',
  'audit.view',
  'tenant.settings',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
export const isPermission = (p: string): p is Permission => PERMISSION_SET.has(p);

export type RoleScope = 'tenant' | 'reseller';

export interface BuiltInRole {
  name: string;
  scope: RoleScope;
  requireMfa: boolean;
  permissions: readonly Permission[];
}

/** Permissions a reseller-scoped role may ever hold; the API refuses anything else on reseller roles. */
export const RESELLER_PERMISSIONS: readonly Permission[] = [
  'subscribers.read',
  'subscribers.write',
  'subscribers.kick',
  'sessions.read',
  'plans.read',
  'resellers.read',
  'resellers.write',
  'wallets.transfer',
  'billing.cash',
  'reports.view',
  'users.read',
  'users.write',
];

export const BUILT_IN_ROLES: readonly BuiltInRole[] = [
  { name: 'ISP Admin', scope: 'tenant', requireMfa: true, permissions: PERMISSIONS },
  {
    name: 'Support',
    scope: 'tenant',
    requireMfa: false,
    permissions: [
      'subscribers.read',
      'subscribers.write',
      'subscribers.kick',
      'sessions.read',
      'nas.read',
      'plans.read',
      'resellers.read',
    ],
  },
  {
    name: 'Accountant',
    scope: 'tenant',
    requireMfa: false,
    permissions: [
      'subscribers.read',
      'plans.read',
      'resellers.read',
      'wallets.transfer',
      'wallets.refund',
      'billing.cash',
      'reports.view',
      'audit.view',
    ],
  },
  { name: 'Reseller Owner', scope: 'reseller', requireMfa: false, permissions: RESELLER_PERMISSIONS },
  {
    name: 'Reseller Staff',
    scope: 'reseller',
    requireMfa: false,
    permissions: ['subscribers.read', 'subscribers.write', 'sessions.read', 'plans.read', 'billing.cash'],
  },
];
