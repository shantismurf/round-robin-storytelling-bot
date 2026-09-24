import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGroundRulesText, formatGroundRulesText, validateGroundRules,
  slugifyGroundRuleLabel, diffGroundRules, isPureAddition, resolveGroundRuleLabels,
  effectiveGroundRulesText,
  GROUND_RULES_MAX_RULES, GROUND_RULES_LABEL_MAX, GROUND_RULES_DESC_MAX,
} from '../story/_groundRules.js';

const cfg = {
  txtGroundRulesErrCount: 'Too many rules (max [max]).',
  txtGroundRulesErrRule: 'Rule [rule_ref] — [reason]',
  txtGroundRulesReasonLabelMissing: 'label is missing.',
  txtGroundRulesReasonLabelTooLong: 'label exceeds [max] characters.',
  txtGroundRulesReasonDescTooLong: 'description exceeds [max] characters.',
};

describe('parseGroundRulesText / formatGroundRulesText', () => {
  test('parses blank-line-delimited blocks into label/description pairs', () => {
    const text = 'Anything Goes\nThis story is open to any and all ideas. Go wild!\n\nKeep It Clean\nThis story\'s rating will stay in the Teen or lower range.';
    const rules = parseGroundRulesText(text);
    assert.equal(rules.length, 2);
    assert.deepEqual(rules[0], { label: 'Anything Goes', description: 'This story is open to any and all ideas. Go wild!' });
    assert.equal(rules[1].label, 'Keep It Clean');
  });

  test('tolerates doubled blank lines between blocks', () => {
    const text = 'Rule One\nDesc one\n\n\n\nRule Two\nDesc two';
    const rules = parseGroundRulesText(text);
    assert.equal(rules.length, 2);
    assert.equal(rules[1].label, 'Rule Two');
  });

  test('a label-only block has an empty description, not a missing one', () => {
    const rules = parseGroundRulesText('Just A Label');
    assert.equal(rules.length, 1);
    assert.equal(rules[0].description, '');
  });

  test('empty/whitespace input parses to no rules', () => {
    assert.deepEqual(parseGroundRulesText(''), []);
    assert.deepEqual(parseGroundRulesText('   \n\n  '), []);
    assert.deepEqual(parseGroundRulesText(null), []);
  });

  test('format is the inverse of parse for round-trip stability', () => {
    const rules = [
      { label: 'Anything Goes', description: 'Go wild!' },
      { label: 'Keep It Clean', description: '' },
    ];
    const formatted = formatGroundRulesText(rules);
    assert.deepEqual(parseGroundRulesText(formatted), rules);
  });
});

describe('validateGroundRules', () => {
  test('accepts a valid list', () => {
    const rules = [{ label: 'A', description: 'desc' }];
    assert.deepEqual(validateGroundRules(rules, cfg), { valid: true });
  });

  test('rejects more than the max rule count', () => {
    const rules = Array.from({ length: GROUND_RULES_MAX_RULES + 1 }, (_, i) => ({ label: `Rule ${i}`, description: '' }));
    const result = validateGroundRules(rules, cfg);
    assert.equal(result.valid, false);
    assert.match(result.error, /Too many rules/);
  });

  test('rejects a label over the cap, naming the rule', () => {
    const rules = [{ label: 'x'.repeat(GROUND_RULES_LABEL_MAX + 1), description: '' }];
    const result = validateGroundRules(rules, cfg);
    assert.equal(result.valid, false);
    assert.match(result.error, /label exceeds 40 characters/);
  });

  test('rejects a description over the 100-char Discord cap, naming the rule', () => {
    const rules = [{ label: 'Keep It Clean', description: 'x'.repeat(GROUND_RULES_DESC_MAX + 1) }];
    const result = validateGroundRules(rules, cfg);
    assert.equal(result.valid, false);
    assert.match(result.error, /"Keep It Clean".*description exceeds 100 characters/);
  });

  test('a missing label is referenced by position, not an empty quoted label', () => {
    // parseGroundRulesText never produces a label-less rule from real input, but validate()
    // still needs to handle one defensively.
    const rules = [{ label: '', description: 'desc' }];
    const result = validateGroundRules(rules, cfg);
    assert.equal(result.valid, false);
    assert.match(result.error, /#1.*label is missing/);
  });

  test('rejects the whole submission on the first error — no partial saves', () => {
    const rules = [
      { label: 'Fine', description: '' },
      { label: 'y'.repeat(50), description: '' },
      { label: 'Also Fine', description: '' },
    ];
    const result = validateGroundRules(rules, cfg);
    assert.equal(result.valid, false);
  });
});

describe('slugifyGroundRuleLabel', () => {
  test('lowercases and hyphenates', () => {
    assert.equal(slugifyGroundRuleLabel('Maintain Tonal Harmony'), 'maintain-tonal-harmony');
  });

  test('strips punctuation and collapses runs of separators', () => {
    assert.equal(slugifyGroundRuleLabel("Respect Other Writers' Choices"), 'respect-other-writers-choices');
  });

  test('strips diacritics to plain ascii', () => {
    assert.equal(slugifyGroundRuleLabel('Café Rules'), 'cafe-rules');
  });
});

describe('diffGroundRules', () => {
  const rule = (label) => ({ label, description: '' });

  test('pure addition: nothing removed, nothing renamed', () => {
    const diff = diffGroundRules([rule('A')], [rule('A'), rule('B')]);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].label, 'B');
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.renamed, null);
    assert.equal(isPureAddition(diff), true);
  });

  test('pure removal is not a pure addition', () => {
    const diff = diffGroundRules([rule('A'), rule('B')], [rule('A')]);
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].label, 'B');
    assert.equal(isPureAddition(diff), false);
  });

  test('exactly one removed + one added is a rename candidate, matched by label text not position', () => {
    const diff = diffGroundRules([rule('Keep It Clean'), rule('Anything Goes')], [rule('Anything Goes'), rule('Keep It Clean And Tidy')]);
    assert.ok(diff.renamed);
    assert.equal(diff.renamed.oldLabel, 'Keep It Clean');
    assert.equal(diff.renamed.newLabel, 'Keep It Clean And Tidy');
    assert.equal(diff.renamed.slug, slugifyGroundRuleLabel('Keep It Clean')); // keeps the OLD slug
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged.length, 1);
  });

  test('reordering alone (same label set) is neither added nor removed', () => {
    const diff = diffGroundRules([rule('A'), rule('B')], [rule('B'), rule('A')]);
    assert.equal(diff.added.length, 0);
    assert.equal(diff.removed.length, 0);
    assert.equal(diff.unchanged.length, 2);
  });

  test('multiple removed + multiple added is never guessed as renames', () => {
    const diff = diffGroundRules([rule('A'), rule('B')], [rule('C'), rule('D')]);
    assert.equal(diff.renamed, null);
    assert.equal(diff.removed.length, 2);
    assert.equal(diff.added.length, 2);
  });
});

describe('approved default vocabulary text', () => {
  // Mirrors db/config_files/config_metadata.sql's txtGroundRulesDefaultVocabulary verbatim —
  // guards against a future edit silently drifting past the real 40/100 limits (the exact
  // failure mode this plan's own 150-vs-100 mistake was).
  const DEFAULT_TEXT = [
    'Anything Goes\nThis story is open to any and all ideas. Go wild!',
    "Maintain Tonal Harmony\nMatch the vibe so far. Keep humor and seriousness consistent with the entries before yours.",
    'Preserve Lore Integrity\nStick to established setting and character facts. Check with the group before adding new ones.',
    "Respect Other Writers' Choices\nDon't permanently change another writer's character or lore without checking with them first.",
    'Conflict, Not Contempt\nIn-story conflict is fair game. Sustained hostility toward a person, group, or idea is not.',
    'Keep It Clean\nThis story\'s rating will stay in the Teen or lower range.',
  ].join('\n\n');

  test('parses to exactly six rules, each within the real 40/100 limits', () => {
    const rules = parseGroundRulesText(DEFAULT_TEXT);
    assert.equal(rules.length, 6);
    for (const rule of rules) {
      assert.ok(rule.label.length <= GROUND_RULES_LABEL_MAX, `label "${rule.label}" (${rule.label.length}) exceeds ${GROUND_RULES_LABEL_MAX}`);
      assert.ok(rule.description.length <= GROUND_RULES_DESC_MAX, `"${rule.label}"'s description (${rule.description.length}) exceeds ${GROUND_RULES_DESC_MAX}`);
    }
    assert.equal(validateGroundRules(rules, cfg).valid, true);
  });
});

describe('effectiveGroundRulesText', () => {
  test('an unconfigured guild (empty/null stored text) runs the default vocabulary', () => {
    assert.equal(effectiveGroundRulesText('', 'Default Rule\nDesc'), 'Default Rule\nDesc');
    assert.equal(effectiveGroundRulesText(null, 'Default Rule\nDesc'), 'Default Rule\nDesc');
    assert.equal(effectiveGroundRulesText('   ', 'Default Rule\nDesc'), 'Default Rule\nDesc');
  });

  test('a guild with its own saved vocabulary (even after deleting all defaults) is never overridden', () => {
    assert.equal(effectiveGroundRulesText('Custom Rule\nDesc', 'Default Rule\nDesc'), 'Custom Rule\nDesc');
  });

  test('no default text configured resolves to empty rather than throwing', () => {
    assert.equal(effectiveGroundRulesText('', undefined), '');
    assert.equal(effectiveGroundRulesText(null, null), '');
  });
});

describe('resolveGroundRuleLabels', () => {
  test('resolves stored slugs against the current vocabulary', () => {
    const current = [{ label: 'Anything Goes', description: '' }, { label: 'Keep It Clean', description: '' }];
    const labels = resolveGroundRuleLabels('anything-goes,keep-it-clean', current);
    assert.deepEqual(labels, ['Anything Goes', 'Keep It Clean']);
  });

  test('a slug no longer in the vocabulary (an actually-deleted rule) is dropped silently', () => {
    const current = [{ label: 'Anything Goes', description: '' }];
    const labels = resolveGroundRuleLabels('anything-goes,some-deleted-rule', current);
    assert.deepEqual(labels, ['Anything Goes']);
  });

  test('empty/null input resolves to no labels', () => {
    assert.deepEqual(resolveGroundRuleLabels('', []), []);
    assert.deepEqual(resolveGroundRuleLabels(null, []), []);
  });
});
