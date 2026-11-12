import * as bcrypt from 'bcryptjs';
import { createHash } from 'crypto';
const SALT_ROUNDS = 10;
function preHash(password: string): string {
  return createHash('sha256').update(password, 'utf8').digest('hex');
}
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(preHash(password), SALT_ROUNDS);
}
export function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(preHash(password), hash);
}
