#!/usr/bin/env node

import { runSetup } from "./installer.mjs";

try {
  await runSetup();
} catch (error) {
  process.stderr.write(
    `dsh-fusion-setup: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
