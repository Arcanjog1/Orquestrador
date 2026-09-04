/**
 * The window's security posture, asserted as data.
 *
 * The real flags are checked inside a running Electron in the integration
 * suite; these tests pin the constants so a well-meaning edit ("just for
 * debugging") cannot loosen them unnoticed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTENT_SECURITY_POLICY,
  WEB_PREFERENCES,
  isExternalHttp,
} from '../apps/desktop/src/electron/security.js';

test('the four non-negotiable window flags are set', () => {
  assert.equal(WEB_PREFERENCES.contextIsolation, true);
  assert.equal(WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(WEB_PREFERENCES.sandbox, true);
  assert.equal(WEB_PREFERENCES.webSecurity, true);
});

test('node is kept out of workers, subframes and webviews too', () => {
  assert.equal(WEB_PREFERENCES.nodeIntegrationInWorker, false);
  assert.equal(WEB_PREFERENCES.nodeIntegrationInSubFrames, false);
  assert.equal(WEB_PREFERENCES.webviewTag, false);
  assert.equal(WEB_PREFERENCES.allowRunningInsecureContent, false);
});

test('the renderer is not allowed to fetch anything of its own', () => {
  assert.match(CONTENT_SECURITY_POLICY, /default-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /connect-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /object-src 'none'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);
  assert.ok(!/script-src[^;]*unsafe-eval/.test(CONTENT_SECURITY_POLICY));
  assert.ok(!/script-src[^;]*unsafe-inline/.test(CONTENT_SECURITY_POLICY));
});

test('only http(s) links are handed to the system browser', () => {
  assert.equal(isExternalHttp('https://claude.ai/login'), true);
  assert.equal(isExternalHttp('http://localhost:3000'), true);
  assert.equal(isExternalHttp('file:///etc/passwd'), false);
  assert.equal(isExternalHttp('javascript:alert(1)'), false);
  assert.equal(isExternalHttp('not a url'), false);
});
