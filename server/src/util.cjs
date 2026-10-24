'use strict';
// Small shared helpers: random secrets, hashing, PKCE, plain-text cleaning and errors.
const { createHash, randomBytes, timingSafeEqual } = require('node:crypto');

const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
const randomId = (prefix, bytes = 18) => prefix + randomBytes(bytes).toString('base64url');

// PKCE S256 (RFC 7636 §4.6): BASE64URL(SHA256(ASCII(code_verifier))) compared in constant time.
function pkceMatches(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return false;
  const actual = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Text a client says about itself, shown to the person as plain text only.
function plain(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// An error whose code and message may be shown to the client as they are.
class ServiceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

// An OAuth error (RFC 6749 §5.2 / RFC 8628 §3.5): `error` and `error_description`, with an HTTP status.
class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { sha256, randomToken, randomId, pkceMatches, plain, ServiceError, OAuthError, sleep };
