export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export class AuthExpiredError extends Error {
  constructor(message = "MonkeyCode session is missing or expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export class RemoteError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RemoteError";
    this.status = status;
  }
}

export class CancelledError extends Error {
  constructor(message = "Task run was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

export class BridgeError extends Error {
  constructor(message, status = 400, code = "browser-bridge-error") {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.code = code;
  }
}
