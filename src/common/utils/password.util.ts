import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';

const SALT_ROUNDS = 10;

// bcrypt silently truncates its input at 72 *bytes*. class-validator's
// @MaxLength counts UTF-16 code units, not bytes, so a password with
// multi-byte characters can exceed 72 bytes while staying under the
// character limit — two different passwords then hash identically and
// both authenticate. Pre-hashing with SHA-256 (a fixed 64-char hex digest)
// keeps bcrypt's input constant-length and well under its limit.
function preHash(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(preHash(password), SALT_ROUNDS);
}

export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(preHash(password), hash);
}
