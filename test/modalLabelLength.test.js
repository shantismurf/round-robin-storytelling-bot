import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Discord rejects a TextInput label longer than 45 UTF-16 units, which makes showModal() throw
// "Invalid string length" before the modal ever opens. Labels live in config, so check them there.
const LABEL_LIMIT = 45;
const SETTINGS_MODAL_LABELS = [
  'lblTurnLength', 'lblTimeoutReminder', 'lblTimeoutReminderSlow',
  'lblNoHours', 'lblNoWriters', 'lblMaxWriters',
];

function configValue(key) {
  for (const f of fs.readdirSync('db/config_files').filter(n => n.endsWith('.sql'))) {
    const m = fs.readFileSync(`db/config_files/${f}`, 'utf8').match(new RegExp(`\\('${key}', '((?:[^']|'')*)'`));
    if (m) return m[1].replace(/''/g, "'");
  }
  return null;
}

for (const key of SETTINGS_MODAL_LABELS) {
  test(`${key} fits a modal text-input label (<= ${LABEL_LIMIT})`, () => {
    const value = configValue(key);
    assert.ok(value, `${key} not found in db/config_files`);
    assert.ok(value.length <= LABEL_LIMIT, `${key} is ${value.length} chars: ${value}`);
  });
}
