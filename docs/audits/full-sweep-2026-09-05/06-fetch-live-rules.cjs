// Read-only: fetch the LIVE Firestore + Storage rulesets of darbo-planavimas through the
// Firebase CLI's own auth layer (same credential store `firebase deploy` uses). Writes nothing
// to Firebase. Output files go to the audit dir passed as argv[2].
const path = require('path');
const fs = require('fs');
const FT = 'C:/Users/karol/AppData/Roaming/npm/node_modules/firebase-tools/lib/';
const auth = require(FT + 'auth');
const { requireAuth } = require(FT + 'requireAuth');
const rules = require(FT + 'gcp/rules');

const PROJECT = 'darbo-planavimas';
const ACCOUNT = 'audrius@medievalclub.org';
const outDir = process.argv[2];

(async () => {
  const account = auth.getAllAccounts().find((a) => a.user && a.user.email === ACCOUNT);
  if (!account) throw new Error('account not in CLI store: ' + ACCOUNT);
  const options = { project: PROJECT, projectId: PROJECT, account: ACCOUNT, nonInteractive: true };
  auth.setActiveAccount(options, account);
  await requireAuth(options);

  const releases = await rules.listAllReleases(PROJECT);
  console.log('releases:', releases.map((r) => `${r.name} -> ${r.rulesetName} (${r.updateTime || r.createTime || ''})`).join('\n          '));

  for (const rel of releases) {
    const files = await rules.getRulesetContent(rel.rulesetName);
    const short = rel.name.split('/releases/')[1].replace(/[\/]/g, '__');
    for (const f of files) {
      const out = path.join(outDir, `06-firebase-live-${short}.rules`);
      fs.writeFileSync(out, f.content);
      console.log('wrote', out, f.content.length, 'chars, source name', f.name);
    }
  }
})().catch((e) => { console.error('FAILED:', e && (e.message || e)); process.exit(1); });
