#!/usr/bin/env node
'use strict';
/**
 * Turns on the address finder, so the phone app can find this PC after a restart.
 *   node scripts/setup-address-finder.js           a pairing code (no account needed; uses ntfy.sh)
 *   node scripts/setup-address-finder.js --gist    a secret gist in your GitHub account (needs the GitHub CLI)
 * To turn it off: delete data/finder.json (and the gist, if you made one).
 */
const path = require('node:path');
const { Finder, prettyCode } = require('../lib/finder');

(async () => {
  const dataDir = path.resolve(process.env.USAGE_MONITOR_DATA_DIR || path.join(__dirname, '..', 'data'));
  const finder = new Finder(dataDir);
  try {
    if (process.argv.includes('--gist')) {
      const existed = Boolean(finder.id);
      const id = await finder.create();
      console.log(existed ? `Gist already set up (${id.slice(0, 6)}…).` : `Made a secret gist (${id.slice(0, 6)}…).`);
    } else {
      const existed = Boolean(finder.code);
      const code = finder.ensureCode();
      console.log(`${existed ? 'Pairing code' : 'New pairing code'}: ${prettyCode(code)}`);
    }
    console.log('Restart the monitor to start using it.');
  } catch (e) {
    console.error(`Could not set up the address finder: ${e.message}`);
    process.exit(1);
  }
})();
