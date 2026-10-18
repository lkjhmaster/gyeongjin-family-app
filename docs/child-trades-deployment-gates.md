# Child-trade backend integration checklist

This is an **unapplied** additive D1/SQLite migration. The existing family API is at `https://gyeongjin-family-api.muse-hooni.workers.dev`. Do not assume it uses D1 until the Worker source and bindings are inspected.

## Deployment prerequisites
1. Identify the actual Cloudflare Worker repository, binding names, existing allowance tables and approval APIs.
2. Back up the live database and verify restore procedure; obtain approval before production migration.
3. Run migration on an isolated test database; inspect all eight new tables, foreign keys and indexes.
4. Implement authenticated endpoints for request, counterparty consent, parent approval, item handover confirmation, settlement, repayment, dispute, cancellation and refund.
5. In every money-changing endpoint: validate server identity and role; load authoritative balances and active holds; check revision; execute postings, hold changes, loan changes, audit and idempotency records in one atomic database transaction.
6. Require a unique operation key and reject stale revisions. Handle both parents approving concurrently and replayed requests.
7. Integrate the existing allowance ledger **once**. Ensure reserved funds are not also posted as spent. Existing minus repayment source rules must be preserved.
8. Run regression tests for midnight-pending approvals, historical data integrity, wallet/calendar totals, and mobile layout.
9. Deploy via the actual Cloudflare project and verify the deployment result, live API, and installed PWA service worker version.
10. Only after backend deployment and verification enable transactional UI. Mobile real-device verification remains a separate step.

## Never do
- Do not enable financial actions using only localStorage or browser-side state.
- Do not overwrite existing allowance rows or replay historical payments.
- Do not mark this schema as applied, the Worker as deployed, or mobile checks as passed without evidence.
