const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const packageInfo = require(path.join(projectRoot, 'package.json'));
const outputPath = path.join(projectRoot, 'build-info.json');

function getGitCommit() {
  if (process.env.DEPLOY_COMMIT) {
    return process.env.DEPLOY_COMMIT.trim().slice(0, 7);
  }

  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (error) {
    return 'unavailable';
  }
}

function getDhakaBuildNumber(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value || '00';

  return `${value('year')}${value('month')}${value('day')}.${value('hour')}${value('minute')}${value('second')}`;
}

const generatedAt = new Date();
const buildInfo = {
  version: packageInfo.version,
  buildNumber: process.env.BUILD_NUMBER?.trim() || getDhakaBuildNumber(generatedAt),
  commit: getGitCommit(),
  environment: process.env.DEPLOY_ENV?.trim() || process.env.NODE_ENV?.trim() || 'production',
  deployedAt: process.env.DEPLOYED_AT?.trim() || generatedAt.toISOString()
};

fs.writeFileSync(outputPath, `${JSON.stringify(buildInfo, null, 2)}\n`, 'utf8');
console.log(`Generated ${path.basename(outputPath)}: v${buildInfo.version}, build ${buildInfo.buildNumber}, commit ${buildInfo.commit}`);
