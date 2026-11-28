import { createRequire } from 'node:module';

/**
 * Starts Playwright MCP for an AI web test inside the run's temp folder (`RELAY_PW_DIR`), so every file it writes
 * (screenshots, named or not) stays there: with `--ignore-roots` that folder is its workspace root. `RELAY_PW_CLI` is
 * the pinned package's `cli.js`; the remaining arguments are its flags.
 */
const dir = process.env.RELAY_PW_DIR;
const cli = process.env.RELAY_PW_CLI;
if (!dir || !cli) {
  process.stderr.write('playwrightMcp: RELAY_PW_DIR and RELAY_PW_CLI are required\n');
  process.exit(2);
}
process.chdir(dir);
createRequire(import.meta.url)(cli);
