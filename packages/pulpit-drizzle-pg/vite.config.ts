import { packageConfig } from "../../vite.package.ts";

// The tasks (check, build, test:unit, docgen, test:coverage) and the vitest
// settings every package shares, plus `test:integration`, the suite against
// a real PostgreSQL (vitest.integration.config.ts); see vite.package.ts.
export default packageConfig("packages/pulpit-drizzle-pg", { integration: true });
