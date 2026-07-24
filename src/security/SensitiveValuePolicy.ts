/**
 * Centralized handling for credentials and other sensitive catalog values.
 *
 * Raw values never appear in decisions, diagnostics, progress events, or
 * errors. A caller-provided resolver receives the source value only at the
 * explicit secure-callback boundary.
 */

import { SecretPolicyError } from '../utils/errors.js';

export type SensitiveValueKind =
  | 'password'
  | 'connection-string'
  | 'foreign-option'
  | 'user-mapping-option'
  | 'subscription-connection'
  | 'role-password'
  | 'extension-option';

export type SensitiveValueMode = 'omit' | 'redact' | 'provide' | 'fail';

export interface SensitiveValueContext {
  readonly kind: SensitiveValueKind;
  readonly objectIdentity: string;
  readonly optionName?: string;
}

export type SensitiveValueProvider = (
  context: SensitiveValueContext,
  sourceValue: string,
) => string | undefined | Promise<string | undefined>;

export interface SensitiveValuePolicy {
  readonly mode?: SensitiveValueMode;
  readonly placeholder?: string;
  readonly provider?: SensitiveValueProvider;
}

export interface SensitiveValueDecision {
  readonly context: SensitiveValueContext;
  readonly action: 'omitted' | 'redacted' | 'provided';
  readonly restorable: boolean;
}

export interface ProtectedSensitiveValue {
  readonly value?: string;
  readonly decision: SensitiveValueDecision;
}

const SENSITIVE_OPTION_NAME =
  /(?:^|[_-])(password|passwd|pass|pwd|secret|token|credential|connection(?:_?string)?|conninfo|sslkey|sslcert|key)(?:$|[_-])/iu;

/** Conservative key classifier used for FDW, extension, and mapping options. */
export function isSensitiveOptionName(name: string): boolean {
  return SENSITIVE_OPTION_NAME.test(name);
}

export function redactSensitiveText(value: string, placeholder = '[REDACTED]'): string {
  return value
    .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+(@)/giu, `$1${placeholder}$2`)
    .replace(
      /\b(password|pass|passwd|pwd|secret|token|sslkey|sslcert)\s*=\s*('[^']*'|"[^"]*"|[^\s;]+)/giu,
      `$1=${placeholder}`,
    );
}

/**
 * Applies one policy decision. Error text is fixed and does not interpolate
 * either the source value or a caller-provided replacement.
 */
export async function protectSensitiveValue(
  context: SensitiveValueContext,
  sourceValue: string,
  policy: SensitiveValuePolicy = {},
): Promise<ProtectedSensitiveValue> {
  const mode = policy.mode ?? 'omit';
  if (mode === 'fail') {
    throw new SecretPolicyError(
      'A selected object contains sensitive metadata rejected by the configured policy.',
    );
  }
  if (mode === 'omit') {
    return {
      decision: { context, action: 'omitted', restorable: false },
    };
  }
  if (mode === 'redact') {
    return {
      value: policy.placeholder ?? '[REDACTED]',
      decision: { context, action: 'redacted', restorable: false },
    };
  }
  if (policy.provider === undefined) {
    throw new SecretPolicyError(
      'Sensitive-value provide mode requires a caller-supplied secure callback.',
    );
  }
  const replacement = await policy.provider(context, sourceValue);
  if (replacement === undefined) {
    return {
      decision: { context, action: 'omitted', restorable: false },
    };
  }
  return {
    value: replacement,
    decision: { context, action: 'provided', restorable: true },
  };
}
