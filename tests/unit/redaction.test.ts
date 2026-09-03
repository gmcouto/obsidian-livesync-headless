import { describe, it, expect } from 'vitest';
import { SecretRedactor } from '../../src/security/redaction.js';
import { Logger } from '../../src/diagnostics/logger.js';

describe('SecretRedactor and Diagnostics Sanitizer', () => {
  it('redacts explicitly registered secrets', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('super-secret-password-123');
    redactor.registerSecret('topsecret');

    const text = 'Connecting with password super-secret-password-123 and topsecret token';
    const redacted = redactor.redactString(text);

    expect(redacted).toBe('Connecting with password [REDACTED] and [REDACTED] token');
  });

  it('ignores registered secrets that are too short (<= 2 characters)', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('a');
    redactor.registerSecret('no');

    const text = 'This is a normal sentence with no secrets.';
    expect(redactor.redactString(text)).toBe(text);
  });

  it('redacts longer secrets first when secrets contain common substrings', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('pass');
    redactor.registerSecret('password-extension');

    const text = 'The key is password-extension.';
    expect(redactor.redactString(text)).toBe('The key is [REDACTED].');
  });

  it('redacts embedded credentials in HTTP and HTTPS URLs', () => {
    const redactor = new SecretRedactor();

    const input1 = 'Failed to fetch from http://admin:mypassword@127.0.0.1:5984/obsidian-vault';
    expect(redactor.redactString(input1)).toBe('Failed to fetch from http://[REDACTED]@127.0.0.1:5984/obsidian-vault');

    const input2 = 'Connecting to https://user_name%40test:p%40ssw0rd!@couchdb.internal:6984/db/_changes';
    expect(redactor.redactString(input2)).toBe('Connecting to https://[REDACTED]@couchdb.internal:6984/db/_changes');

    const inputNoAuth = 'Clean URL: http://localhost:5984/db';
    expect(redactor.redactString(inputNoAuth)).toBe(inputNoAuth);
  });

  it('redacts HTTP Authorization headers (Bearer and Basic)', () => {
    const redactor = new SecretRedactor();

    const bearer = 'Headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.abc.def" }';
    expect(redactor.redactString(bearer)).toBe('Headers: { Authorization: "Bearer [REDACTED]" }');

    const basic = 'Headers: { Authorization: "Basic YWRtaW46c2VjcmV0" }';
    expect(redactor.redactString(basic)).toBe('Headers: { Authorization: "Basic [REDACTED]" }');
  });

  it('redacts LiveSync setup URIs', () => {
    const redactor = new SecretRedactor();

    const uri = 'Importing vault from obsidian://livesync?settings=eyJ1cmwiOiJodHRwczovL2V4YW1wbGUuY29tIn0= successfully';
    expect(redactor.redactString(uri)).toBe('Importing vault from obsidian://livesync?[REDACTED] successfully');
  });

  it('redacts error messages and stack traces', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('ultra-secret-key');

    const err = new Error('Connection failed: http://admin:ultra-secret-key@127.0.0.1:5984');
    const redactedErr = redactor.redactError(err);

    expect(redactedErr.message).toBe('Connection failed: http://[REDACTED]@127.0.0.1:5984');
    expect(redactedErr.message).not.toContain('ultra-secret-key');
    if (redactedErr.stack) {
      expect(redactedErr.stack).not.toContain('ultra-secret-key');
    }
  });

  it('recursively scrubs objects and masks sensitive keys', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('plain-in-value');

    const payload = {
      service: 'couchdb',
      url: 'http://admin:pass123@localhost:5984',
      remotePassword: 'do-not-expose',
      nested: {
        authToken: 'xyz-999',
        encryptionPassphrase: 'my-passphrase',
        notes: 'Contains plain-in-value here',
      },
      tags: ['alpha', 'plain-in-value', 'beta'],
    };

    const cleaned = redactor.redactObject(payload) as Record<string, unknown>;

    expect(cleaned.service).toBe('couchdb');
    expect(cleaned.url).toBe('http://[REDACTED]@localhost:5984');
    expect(cleaned.remotePassword).toBe('[REDACTED]');

    const nested = cleaned.nested as Record<string, unknown>;
    expect(nested.authToken).toBe('[REDACTED]');
    expect(nested.encryptionPassphrase).toBe('[REDACTED]');
    expect(nested.notes).toBe('Contains [REDACTED] here');

    expect(cleaned.tags).toEqual(['alpha', '[REDACTED]', 'beta']);
  });

  it('handles circular references in redactObject without crashing', () => {
    const redactor = new SecretRedactor();
    const circular: Record<string, unknown> = { name: 'cyclic' };
    circular.self = circular;

    const cleaned = redactor.redactObject(circular) as Record<string, unknown>;
    expect(cleaned.name).toBe('cyclic');
    expect(cleaned.self).toBe('[Circular]');
  });

  it('sanitizes logs through Logger when wired with SecretRedactor', () => {
    const redactor = new SecretRedactor();
    redactor.registerSecret('db-secret-password');

    const lines: string[] = [];
    const testLogger = new Logger('debug', redactor);
    testLogger.setDestination((line) => lines.push(line));

    testLogger.info('Authenticating with db-secret-password', {
      url: 'http://admin:db-secret-password@localhost:5984',
      password: 'db-secret-password',
      normalField: 'ok',
    });

    expect(lines.length).toBe(1);
    const logged = JSON.parse(lines[0]);

    expect(logged.message).toBe('Authenticating with [REDACTED]');
    expect(logged.url).toBe('http://[REDACTED]@localhost:5984');
    expect(logged.password).toBe('[REDACTED]');
    expect(logged.normalField).toBe('ok');
  });
});
