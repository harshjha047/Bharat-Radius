import type { Permission } from './auth';

/** Grouped and named the way staff think about them. */
export const PERMISSION_GROUPS: { label: string; items: [Permission, string][] }[] = [
  {
    label: 'Subscribers',
    items: [
      ['subscribers.read', 'View subscribers'],
      ['subscribers.write', 'Create, edit, suspend'],
      ['subscribers.delete', 'Delete subscribers'],
      ['subscribers.kick', 'Kick sessions'],
      ['subscribers.password.reveal', 'See PPPoE passwords'],
      ['subscribers.export', 'Export to Excel'],
      ['imports.run', 'Import from Excel'],
      ['sessions.read', 'Sessions and login logs'],
    ],
  },
  {
    label: 'Network',
    items: [
      ['nas.read', 'View routers'],
      ['nas.write', 'Manage routers and secrets'],
      ['plans.read', 'View plans'],
      ['plans.write', 'Manage plans'],
    ],
  },
  {
    label: 'Resellers and money',
    items: [
      ['resellers.read', 'View resellers'],
      ['resellers.write', 'Manage resellers'],
      ['billing.read', 'View wallets, recharges, invoices, payments'],
      ['recharges.create', 'Recharge subscribers'],
      ['wallets.transfer', 'Wallet top-ups and transfers'],
      ['wallets.refund', 'Refunds and credit notes'],
      ['wallets.adjust', 'Wallet adjustments'],
      ['billing.cash', 'Record cash payments'],
      ['reports.view', 'Reports'],
    ],
  },
  {
    label: 'Administration',
    items: [
      ['users.read', 'View staff'],
      ['users.write', 'Manage staff'],
      ['roles.write', 'Manage roles'],
      ['audit.view', 'Audit log'],
      ['tenant.settings', 'ISP settings'],
    ],
  },
];
