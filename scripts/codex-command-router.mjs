#!/usr/bin/env node

import process from "node:process";
import { runRouterCli } from "./weixin-command-router.mjs";

runRouterCli(process.argv.slice(2), { allChannels: true }).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
