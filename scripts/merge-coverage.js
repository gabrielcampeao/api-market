const fs = require('fs');
const path = require('path');
const libCoverage = require('istanbul-lib-coverage');
const libReport = require('istanbul-lib-report');
const reports = require('istanbul-reports');

const [unitDir, e2eDir, outDir] = process.argv.slice(2);
if (!unitDir || !e2eDir || !outDir) {
  console.error('Usage: node merge-coverage.js <unitCoverageDir> <e2eCoverageDir> <outDir>');
  process.exit(1);
}

const map = libCoverage.createCoverageMap({});
for (const dir of [unitDir, e2eDir]) {
  const file = path.join(dir, 'coverage-final.json');
  if (!fs.existsSync(file)) {
    console.warn(`No coverage-final.json in ${dir}, skipping`);
    continue;
  }
  map.merge(JSON.parse(fs.readFileSync(file, 'utf8')));
}

fs.mkdirSync(outDir, { recursive: true });
const context = libReport.createContext({ dir: outDir, coverageMap: map });
reports.create('json-summary').execute(context);
reports.create('text').execute(context);
