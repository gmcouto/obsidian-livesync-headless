export class SecretRedactor {
  private readonly secretValues = new Set<string>();

  registerSecret(secret: string | undefined): void {
    if (secret && typeof secret === 'string' && secret.trim().length > 2) {
      this.secretValues.add(secret);
    }
  }

  redactString(text: string): string {
    if (!text || typeof text !== 'string') {
      return text;
    }

    let result = text;

    // Redact registered secrets in descending length order to avoid partial collisions
    if (this.secretValues.size > 0) {
      const sortedSecrets = Array.from(this.secretValues).sort((a, b) => b.length - a.length);
      for (const secret of sortedSecrets) {
        result = result.replaceAll(secret, '[REDACTED]');
      }
    }

    // Redact embedded userinfo in HTTP/HTTPS URLs: https://user:pass@host -> https://[REDACTED]@host
    result = result.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/]+@/g, '$1[REDACTED]@');

    // Redact Authorization headers: Bearer and Basic
    result = result.replace(/Bearer\s+[A-Za-z0-9-_.]+/gi, 'Bearer [REDACTED]');
    result = result.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');

    // Redact LiveSync setup URIs
    result = result.replace(/obsidian:\/\/livesync\?[^\s"']+/gi, 'obsidian://livesync?[REDACTED]');

    return result;
  }

  redactError(err: unknown): Error {
    if (!(err instanceof Error)) {
      return new Error(this.redactString(String(err)));
    }

    const cloned = new Error(this.redactString(err.message));
    cloned.name = err.name;
    if (err.stack) {
      cloned.stack = this.redactString(err.stack);
    }
    if ('cause' in err && err.cause) {
      cloned.cause = this.redactObject(err.cause);
    }
    return cloned;
  }

  redactObject(obj: unknown, seen = new WeakSet<object>()): unknown {
    if (typeof obj === 'string') {
      return this.redactString(obj);
    }

    if (obj === null || typeof obj !== 'object') {
      return obj;
    }

    if (obj instanceof Error) {
      return this.redactError(obj);
    }

    if (obj instanceof Date) {
      return new Date(obj.getTime());
    }

    if (seen.has(obj)) {
      return '[Circular]';
    }
    seen.add(obj);

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redactObject(item, seen));
    }

    const sensitiveKeyPattern = /(password|passphrase|secret|auth|token|credential)/i;
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      if (sensitiveKeyPattern.test(key)) {
        result[key] = '[REDACTED]';
      } else {
        result[key] = this.redactObject(value, seen);
      }
    }

    return result;
  }
}

export const defaultRedactor = new SecretRedactor();
