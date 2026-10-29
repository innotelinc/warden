/**
 * The built-in rules live in `src/shared` so the mobile build can use the same
 * tracker list Scry classifies against. Re-exported here because every privacy
 * caller already imports this path, and a churn of four imports would buy
 * nothing but a wider diff.
 */
export * from '../../shared/builtin-lists'
