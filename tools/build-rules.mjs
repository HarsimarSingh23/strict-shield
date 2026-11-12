#!/usr/bin/env node
/*
 * Turns the human-editable lists in filters/*.txt into Chrome
 * declarativeNetRequest rulesets in extension/rules/*.json.
 *
 *   node tools/build-rules.mjs
 *   node tools/build-rules.mjs --import easylist.txt --into ads
 *
 * List syntax (one per line, # starts a comment):
 *   example.com                  block example.com and all subdomains
 *   ||example.com^               same thing, Adblock Plus style
 *   ||example.com/path/*.js      urlFilter rule (blocks matching URLs only)
 *   /prebid.js                   urlFilter rule matched anywhere in a URL
 *
 * --import pulls the domain-only rules ("||domain^", optionally with
 * $third-party etc.) out of an Adblock Plus style list such as EasyList and
 * merges them into the chosen list. Check the list's licence before shipping.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = ['ads', 'trackers'];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;

function parseList(text) {
  const domains = new Set();
  const filters = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('[')) continue;
    if (line.startsWith('@@') || line.includes('##') || line.includes('#@#') || line.includes('#?#')) continue;
    const abpDomain = line.match(/^\|\|([a-z0-9.-]+)\^(\$[^,]*(,[^,]*)*)?$/i);
    if (abpDomain && !/\$.*(domain=|~third-party|first-party|1p)/.test(line)) {
      const d = abpDomain[1].toLowerCase();
      if (DOMAIN.test(d)) domains.add(d);
      continue;
    }
    if (line.startsWith('||') || line.startsWith('/')) {
      filters.add(line.split('$')[0]);
      continue;
    }
    const d = line.toLowerCase();
    if (DOMAIN.test(d)) domains.add(d);
    else console.warn(`skipped: ${line}`);
  }
  // Drop domains already covered by a parent domain in the list.
  for (const d of domains) {
    const parts = d.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (domains.has(parts.slice(i).join('.'))) { domains.delete(d); break; }
    }
  }
  return { domains: [...domains].sort(), filters: [...filters].sort() };
}

function toRules(name, { domains, filters }) {
  const rules = [];
  let id = 1;
  if (domains.length) {
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { requestDomains: domains } });
  }
  for (const urlFilter of filters) {
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { urlFilter, isUrlFilterCaseSensitive: false } });
  }
  if (name === 'trackers') {
    // <a ping> and navigator.sendBeacon() to other sites are pure tracking.
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { domainType: 'thirdParty', resourceTypes: ['ping'] } });
  }
  return rules;
}

const args = process.argv.slice(2);
const importIdx = args.indexOf('--import');
if (importIdx !== -1) {
  const source = args[importIdx + 1];
  const into = args[args.indexOf('--into') + 1] || 'ads';
  if (!source || !LISTS.includes(into)) {
    console.error('usage: node tools/build-rules.mjs --import <file> --into ads|trackers');
    process.exit(1);
  }
  const imported = parseList(readFileSync(source, 'utf8')).domains;
  const target = join(root, 'filters', `${into}.txt`);
  const existing = new Set(parseList(readFileSync(target, 'utf8')).domains);
  const fresh = imported.filter((d) => !existing.has(d));
  appendFileSync(target, `\n# Imported from ${source} on ${new Date().toISOString().slice(0, 10)}\n${fresh.join('\n')}\n`);
  console.log(`imported ${fresh.length} new domains into filters/${into}.txt`);
}

for (const name of LISTS) {
  const parsed = parseList(readFileSync(join(root, 'filters', `${name}.txt`), 'utf8'));
  const rules = toRules(name, parsed);
  writeFileSync(join(root, 'extension', 'rules', `${name}.json`), JSON.stringify(rules, null, 1) + '\n');
  console.log(`${name}: ${parsed.domains.length} domains, ${parsed.filters.length} url filters -> ${rules.length} rules`);
}
