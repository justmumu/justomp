import { pnpmAdapter } from "../../../../src/dependencies/adapters/pnpm";
import { managerCases } from "./npm-pnpm-cases";

managerCases("pnpm", pnpmAdapter);

import { gitCases } from "./npm-pnpm-cases";

gitCases("pnpm", pnpmAdapter);
