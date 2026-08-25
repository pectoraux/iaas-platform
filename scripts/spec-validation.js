#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const specDir = path.join(root, 'spec');
const requiredFiles = [
  'README.md',
  'architecture.md',
  'architecture-lock.md',
  'requirements.md',
  'work-items.md',
  'dependency-graph.md',
  'work-order-template.md',
  'architecture-change-request.md',
  'verification.md',
];

const fail = (message) => {
  console.error(`SPEC VALIDATION FAILED: ${message}`);
  process.exitCode = 1;
};

for (const file of requiredFiles) {
  const filePath = path.join(specDir, file);
  if (!fs.existsSync(filePath)) {
    fail(`missing required file: spec/${file}`);
  }
}

if (process.exitCode) process.exit();

const read = (file) => fs.readFileSync(path.join(specDir, file), 'utf8');
const architecture = read('architecture.md');
const lock = read('architecture-lock.md');
const requirements = read('requirements.md');
const workItems = read('work-items.md');
const graph = read('dependency-graph.md');
const workOrder = read('work-order-template.md');
const acr = read('architecture-change-request.md');
const verification = read('verification.md');

const required = [
  ['architecture version', architecture.includes('IAAS-GOV-ARCH-1')],
  ['frozen status', lock.includes('FROZEN')],
  ['domain architecture pending', architecture.includes('IAAS-DOM-ARCH-1')],
  ['truth classification', lock.includes('OBSERVED') && lock.includes('INFERRED') && lock.includes('CONFIRMED') && lock.includes('PROPOSED')],
  ['single active PR rule', lock.includes('one active implementation PR')],
  ['verification separation', verification.includes('Architect Review') && verification.includes('Verification')],
  ['agent cannot establish PASS', verification.includes('Agent narrative is contextual only and cannot establish PASS')],
  ['architecture change request', workOrder.includes('architecture change required') && acr.includes('NEW ARCHITECTURE VERSION')],
  ['WORK-001 exists', workItems.includes('WORK-001')],
  ['WORK-002 depends on WORK-001', workItems.includes('WORK-002') && workItems.includes('Dependencies: `WORK-001`')],
  ['dependency gate', graph.includes('WORK-001 -> WORK-002') && graph.includes('WORK-002 is blocked until WORK-001 is VERIFIED')],
  ['no production implementation', workItems.includes('no IAAS production code changes in WORK-001')],
];

for (const [label, ok] of required) {
  if (!ok) fail(label);
}

const acIds = [...workItems.matchAll(/`(W001-AC\d+)`/g)].map((m) => m[1]);
const uniqueAcIds = new Set(acIds);
if (acIds.length !== uniqueAcIds.size) fail('duplicate WORK-001 acceptance criterion IDs');
for (let i = 1; i <= 13; i += 1) {
  if (!uniqueAcIds.has(`W001-AC${String(i).padStart(2, '0')}`)) {
    fail(`missing W001-AC${String(i).padStart(2, '0')}`);
  }
}

const filesMentioned = requiredFiles.filter((file) => read('README.md').includes(file));
if (filesMentioned.length !== requiredFiles.length) fail('README.md does not index every required specification file');

if (!process.exitCode) {
  console.log('SPEC VALIDATION PASSED');
  console.log(`validated ${requiredFiles.length} required specification files and 13 WORK-001 acceptance criteria`);
}
