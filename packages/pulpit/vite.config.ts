import { packageConfig } from "../../vite.package.ts";

// The tasks (check, build, test:unit, docgen, test:coverage) and the vitest
// settings every package shares; see vite.package.ts.
export default packageConfig("packages/pulpit");
