export type BridgeErrorCode =
  | 'E_AGY_NOT_FOUND'
  | 'E_AGY_RUN_FAILED'
  | 'E_AGY_TIMEOUT'
  | 'E_AGY_ABORTED'
  | 'E_INVALID_WORKSPACE'
  | 'E_PROJECT_EXISTS'
  | 'E_PROJECT_NOT_FOUND'
  | 'E_CONFIG_INVALID'
  | 'E_IMAGE_GEN_FAILED'
  | 'E_LARK_API_ERROR';

export class BridgeError extends Error {
  public readonly code: BridgeErrorCode;
  public readonly hint: string;
  public readonly detail?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message: string, hint: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.hint = hint;
    this.detail = detail;
    Object.setPrototypeOf(this, BridgeError.prototype);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      detail: this.detail,
    };
  }
}
