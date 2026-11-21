// Settings a person wrote by hand, and the environment.
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, loadConfig } from '../src/core/config.ts';

const saved = { ...process.env };

const settings = (value: unknown) => {
  fs.mkdirSync(path.join(process.env.XDG_CONFIG_HOME!, 'pixling'), { recursive: true });
  fs.writeFileSync(path.join(process.env.XDG_CONFIG_HOME!, 'pixling', 'proxy.json'), JSON.stringify(value));
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) if (key.startsWith('PIXLING_PROXY_')) delete process.env[key];
  process.env.XDG_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'pixling-config-test-'));
});
afterEach(() => {
  process.env = { ...saved };
});

test('with nothing set, the defaults', () => {
  expect(loadConfig()).toMatchObject({ ...DEFAULTS, language: expect.stringMatching(/^(en|ja|zh-Hant|ko)$/) });
});

test('takes the settings that are right', () => {
  settings({
    show: { maxChars: 100, text: false, tools: ['Bash', '!Read'], reasoning: 'summary', everyMs: 5000 },
    permissionWaitMs: 0,
    asset: ['No.2', 'No.3'],
    language: 'ja',
  });
  expect(loadConfig()).toMatchObject({
    show: { reply: true, maxChars: 100, text: false, tools: ['Bash', '!Read'], reasoning: 'summary', everyMs: 5000 },
    permissionWaitMs: 0,
    asset: ['No.2', 'No.3'],
    language: 'ja',
  });
});

test.each([
  ['permissionWaitMs', '60000'],
  ['permissionWaitMs', -1],
  ['turnEndWaitMs', null],
  ['receive', 1],
  ['asset', 7],
  ['asset', [1, 2]],
])('%s: %j keeps its default, and the other settings', (key, value) => {
  settings({ [key]: value, unattended: true });
  const config = loadConfig();
  expect(config[key as keyof typeof config]).toEqual(DEFAULTS[key as keyof typeof DEFAULTS]);
  expect(config.unattended).toBe(true);
});

test.each([
  ['maxChars', '4k'],
  ['maxChars', 0],
  ['everyMs', -5],
  ['text', 'false'],
  ['reasoning', 'some'],
  ['tools', 'few'],
  ['tools', [1]],
])('show.%s: %j keeps its default, and the rest of show', (key, value) => {
  settings({ show: { [key]: value, reply: false } });
  const { show } = loadConfig();
  expect(show[key as keyof typeof show]).toEqual(DEFAULTS.show[key as keyof typeof DEFAULTS.show]);
  expect(show.reply).toBe(false);
});

test.each([
  ['all', 'all'],
  ['none', 'none'],
  ['Bash, mcp__*,!Read', ['Bash', 'mcp__*', '!Read']],
])('PIXLING_PROXY_TOOLS=%s', (value, expected) => {
  process.env.PIXLING_PROXY_TOOLS = value;
  expect(loadConfig().show.tools).toEqual(expected);
});

test('a language it does not know falls back to the locale', () => {
  settings({ language: 'fr' });
  expect(loadConfig().language).toMatch(/^(en|ja|zh-Hant|ko)$/);
});

test.each([
  ['en', 'en'],
  ['ja', 'ja'],
  ['zh-Hant', 'zh-Hant'],
  ['zh-hant', 'zh-Hant'],
  ['ko', 'ko'],
  ['KO', 'ko'],
])('language setting %j resolves to %j', (given, expected) => {
  settings({ language: given });
  expect(loadConfig().language).toBe(expected);
});

test('PIXLING_PROXY_LANGUAGE overrides settings and normalizes casing', () => {
  settings({ language: 'ja' });
  process.env.PIXLING_PROXY_LANGUAGE = 'zh-hant';
  expect(loadConfig().language).toBe('zh-Hant');
  process.env.PIXLING_PROXY_LANGUAGE = 'ko';
  expect(loadConfig().language).toBe('ko');
});

test.each([[[]], [null], ['text'], [3]])('a settings file holding %j means defaults', (value) => {
  settings(value);
  expect(loadConfig().show).toEqual(DEFAULTS.show);
});

test('the environment wins, and a number it garbles keeps the default', () => {
  settings({ permissionWaitMs: 5 });
  process.env.PIXLING_PROXY_PERMISSION_WAIT_MS = 'soon';
  process.env.PIXLING_PROXY_ASSET = 'No.1, No.2';
  process.env.PIXLING_PROXY_RECEIVE = '0';
  expect(loadConfig()).toMatchObject({
    permissionWaitMs: DEFAULTS.permissionWaitMs,
    asset: ['No.1', 'No.2'],
    receive: false,
  });
  process.env.PIXLING_PROXY_PERMISSION_WAIT_MS = '250';
  expect(loadConfig().permissionWaitMs).toBe(250);
});

test('LC_ALL outranks LANG', () => {
  process.env.LC_ALL = 'ja_JP.UTF-8';
  process.env.LANG = 'en_US.UTF-8';
  expect(loadConfig().language).toBe('ja');
  process.env.LC_ALL = 'en_US.UTF-8';
  process.env.LANG = 'ja_JP.UTF-8';
  expect(loadConfig().language).toBe('en');
});

test.each([
  ['ja_JP.UTF-8', 'ja'],
  ['ko_KR.UTF-8', 'ko'],
  ['zh_TW.UTF-8', 'zh-Hant'],
  ['zh_HK.UTF-8', 'zh-Hant'],
  ['zh_MO.UTF-8', 'zh-Hant'],
  ['zh_Hant_TW.UTF-8', 'zh-Hant'],
  ['zh-Hant', 'zh-Hant'],
  ['zh_CN.UTF-8', 'en'],
  ['zh_Hans_CN.UTF-8', 'en'],
  ['en_US.UTF-8', 'en'],
  ['C.UTF-8', 'en'],
])('locale %s maps to %s', (locale, expected) => {
  delete process.env.LC_ALL;
  delete process.env.LC_MESSAGES;
  process.env.LANG = locale;
  expect(loadConfig().language).toBe(expected);
});
